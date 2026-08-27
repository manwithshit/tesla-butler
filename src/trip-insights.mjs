import { haversineMeters } from "./routes.mjs";
import { groupDriveSegments } from "./trip-sessions.mjs";

const minimumComparableTrips = 3;
const routeThresholdMeters = 750;

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validPoint(lat, lng) {
  return number(lat) !== null && number(lng) !== null;
}

function sameDirectedRoute(left, right) {
  if (![left, right].every((trip) =>
    validPoint(trip.start_lat, trip.start_lng) && validPoint(trip.end_lat, trip.end_lng))) return false;
  return haversineMeters(
    { lat: left.start_lat, lng: left.start_lng },
    { lat: right.start_lat, lng: right.start_lng }
  ) <= routeThresholdMeters && haversineMeters(
    { lat: left.end_lat, lng: left.end_lng },
    { lat: right.end_lat, lng: right.end_lng }
  ) <= routeThresholdMeters;
}

function disjointSegments(current, previous) {
  const currentIds = new Set((current.segment_ids || []).map(String));
  return !(previous.segment_ids || []).some((id) => currentIds.has(String(id)));
}

function reliable(trip) {
  return number(trip?.distance_km) >= 2
    && number(trip?.observed_seconds) >= 180
    && number(trip?.sample_coverage) >= 0.9;
}

function comparableTrips(current, history) {
  return (history || []).filter((trip) =>
    reliable(trip) && disjointSegments(current, trip) && sameDirectedRoute(current, trip));
}

function stoppedMinutes(trip) {
  return Math.max(0, Math.round((number(trip.stopped_seconds) || 0) / 60));
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (number(row[field]) || 0), 0);
}

function sumWhenComplete(rows, field) {
  return rows.every((row) => number(row[field]) !== null) ? sum(rows, field) : null;
}

function withInsightMetrics(trip, segments) {
  const durationSeconds = segments.every((segment) => number(segment.duration_seconds) !== null)
    ? sum(segments, "duration_seconds")
    : sum(segments, "duration_min") * 60;
  const observedSeconds = sum(segments, "observed_seconds");
  return {
    ...trip,
    observed_seconds: observedSeconds,
    stopped_seconds: sum(segments, "stopped_seconds"),
    strong_accel_count: sum(segments, "strong_accel_count"),
    strong_decel_count: sum(segments, "strong_decel_count"),
    drawn_kwh: sumWhenComplete(segments, "drawn_kwh"),
    regenerated_kwh: sumWhenComplete(segments, "regenerated_kwh"),
    ascent_m: sumWhenComplete(segments, "ascent_m"),
    sample_coverage: durationSeconds > 0
      ? Number(Math.min(1, observedSeconds / durationSeconds).toFixed(2))
      : 0
  };
}

export function buildTripInsightSessions(drives = [], options = {}) {
  const byId = new Map(drives.map((drive) => [String(drive.id), drive]));
  return groupDriveSegments(drives, options).map((trip) => {
    const segments = trip.segment_ids.map((id) => byId.get(String(id))).filter(Boolean);
    return withInsightMetrics(trip, segments);
  });
}

function sameSegments(left = [], right = []) {
  const leftIds = [...left].map(String).sort();
  const rightIds = [...right].map(String).sort();
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index]);
}

export function selectTripAdviceForTrip(trip, drives = [], options = {}) {
  const sessions = buildTripInsightSessions(drives, options);
  const grouped = sessions.find((session) => sameSegments(session.segment_ids, trip?.segment_ids));
  const requestedIds = new Set((trip?.segment_ids || []).map(String));
  const segments = drives.filter((drive) => requestedIds.has(String(drive.id)));
  const current = segments.length === requestedIds.size
    ? withInsightMetrics({ ...grouped, ...trip }, segments)
    : grouped;
  return current ? selectTripAdvice(current, sessions) : null;
}

function selectTripAdviceCandidate(current, history = []) {
  if (!reliable(current)) return null;
  const comparable = comparableTrips(current, history);
  if (comparable.length < minimumComparableTrips) return null;

  const currentObserved = number(current.observed_seconds);
  const baselineStopRatio = median(comparable.map((trip) =>
    (number(trip.stopped_seconds) || 0) / number(trip.observed_seconds)));
  const currentStopRatio = (number(current.stopped_seconds) || 0) / currentObserved;
  const currentMinutes = stoppedMinutes(current);
  const baselineMinutes = Math.max(0, Math.round(baselineStopRatio * currentObserved / 60));
  const savedMinutes = baselineMinutes - currentMinutes;
  const currentDistance = number(current.distance_km);
  const currentDrawn = number(current.drawn_kwh);
  const currentRegen = number(current.regenerated_kwh);
  const completeEnergy = currentDrawn !== null && currentRegen !== null
    && comparable.every((trip) => number(trip.drawn_kwh) !== null
      && number(trip.regenerated_kwh) !== null);
  const currentNetEnergyPerKm = completeEnergy
    ? (currentDrawn - currentRegen) / currentDistance
    : null;
  const baselineEnergyPerKm = completeEnergy
    ? median(comparable.map((trip) =>
        (number(trip.drawn_kwh) - number(trip.regenerated_kwh)) / number(trip.distance_km)))
    : null;
  const completeAscent = number(current.ascent_m) !== null
    && comparable.every((trip) => number(trip.ascent_m) !== null);
  const currentAscentPerKm = completeAscent ? number(current.ascent_m) / currentDistance : null;
  const baselineAscentPerKm = completeAscent
    ? median(comparable.map((trip) => number(trip.ascent_m) / number(trip.distance_km)))
    : null;
  if (
    currentAscentPerKm !== null
    && baselineAscentPerKm !== null
    && currentNetEnergyPerKm !== null
    && baselineEnergyPerKm > 0
    && currentAscentPerKm - baselineAscentPerKm >= 5
    && currentNetEnergyPerKm >= baselineEnergyPerKm * 1.15
  ) {
    const ascent = Math.round((number(current.ascent_m) || 0) / 10) * 10;
    const energyWhPerKm = Math.round(currentNetEnergyPerKm * 1_000);
    return {
      code: "uphill",
      title: "⛰️ 上坡挑战局",
      detail: `这趟累计爬升 ${ascent} 米，单位里程耗电 ${energyWhPerKm} Wh/km。主要是上坡更费电，驾驶节奏本身没有明显问题。`,
      baseline_count: comparable.length
    };
  }
  const extraMinutes = currentMinutes - baselineMinutes;
  if (extraMinutes >= 2 && currentStopRatio - baselineStopRatio >= 0.08) {
    return {
      code: "stop_heavy",
      title: "🚦 城市闯关局",
      detail: `这趟开车过程中，车停住的时间一共 ${currentMinutes} 分钟，平时类似行程约 ${baselineMinutes} 分钟。今天多停了 ${extraMinutes} 分钟，能耗高一些主要是因为路上不够顺。`,
      baseline_count: comparable.length
    };
  }
  if (savedMinutes >= 2 && baselineStopRatio - currentStopRatio >= 0.05) {
    return {
      code: "smooth_trip",
      title: "🛣️ 一路丝滑",
      detail: `这趟开车过程中，车停住的时间一共 ${currentMinutes} 分钟，平时类似行程约 ${baselineMinutes} 分钟。今天少停了 ${savedMinutes} 分钟，一路更顺。`,
      baseline_count: comparable.length
    };
  }
  const baselineRegenRatio = median(comparable.map((trip) =>
    number(trip.regenerated_kwh) / number(trip.drawn_kwh)));
  const currentRegenRatio = currentRegen / currentDrawn;
  if (
    completeEnergy
    && currentDrawn > 0
    && currentRegen > 0
    && baselineEnergyPerKm > 0
    && currentRegenRatio - baselineRegenRatio >= 0.08
  ) {
    const equivalentKm = currentRegen / baselineEnergyPerKm;
    return {
      code: "regen_expert",
      title: "♻️ 回收高手",
      detail: `这趟一共回收了 ${currentRegen.toFixed(2)} 度电。按你近期每公里平均耗电 ${baselineEnergyPerKm.toFixed(2)} 度算，差不多够跑 ${equivalentKm.toFixed(1)} 公里。`,
      baseline_count: comparable.length
    };
  }
  const baselineAccelRate = median(comparable.map((trip) =>
    (number(trip.strong_accel_count) || 0) / number(trip.observed_seconds)));
  const currentAccel = number(current.strong_accel_count) || 0;
  const baselineAccel = Math.max(0, Math.round(baselineAccelRate * currentObserved));
  if (currentAccel - baselineAccel >= 2) {
    return {
      code: "strong_acceleration",
      title: "🔥 有点热血",
      detail: `这趟明显加速 ${currentAccel} 次，平时类似行程通常只有 ${baselineAccel} 次。起步可以再渐进一点。`,
      baseline_count: comparable.length
    };
  }
  const baselineDecelRate = median(comparable.map((trip) =>
    (number(trip.strong_decel_count) || 0) / number(trip.observed_seconds)));
  const currentDecel = number(current.strong_decel_count) || 0;
  const baselineDecel = Math.max(0, Math.round(baselineDecelRate * currentObserved));
  if (currentDecel - baselineDecel >= 2) {
    return {
      code: "strong_deceleration",
      title: "🧘 收尾再从容点",
      detail: `这趟明显减速 ${currentDecel} 次，平时类似行程通常只有 ${baselineDecel} 次。提前一点松电门会更从容。`,
      baseline_count: comparable.length
    };
  }
  const currentEvents = (number(current.strong_accel_count) || 0)
    + (number(current.strong_decel_count) || 0);
  const baselineEventRate = median(comparable.map((trip) => (
    (number(trip.strong_accel_count) || 0) + (number(trip.strong_decel_count) || 0)
  ) / number(trip.observed_seconds)));
  const baselineEvents = Math.max(0, Math.round(baselineEventRate * currentObserved));
  if (baselineEvents - currentEvents >= 2) {
    const acceleration = number(current.strong_accel_count) || 0;
    const deceleration = number(current.strong_decel_count) || 0;
    const decelerationText = deceleration === 0
      ? "没有明显减速"
      : `${deceleration} 次明显减速`;
    return {
      code: "veteran",
      title: "🚘 老司机模式",
      detail: `这趟只有 ${acceleration} 次明显加速，${decelerationText}。平时类似行程通常会有 ${baselineEvents} 次左右，这趟开得更稳。`,
      baseline_count: comparable.length
    };
  }
  return null;
}

function utcMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const result = new Date(normalized).getTime();
  return Number.isFinite(result) ? result : null;
}

export function selectTripAdvice(current, history = []) {
  const advice = selectTripAdviceCandidate(current, history);
  if (!advice) return null;

  const currentStartedAt = utcMs(current?.start_at);
  if (currentStartedAt === null) return advice;
  const recentComparable = comparableTrips(current, history)
    .filter((trip) => utcMs(trip.end_at) !== null && utcMs(trip.end_at) < currentStartedAt)
    .sort((left, right) => utcMs(right.end_at) - utcMs(left.end_at))
    .slice(0, 5);

  for (const previous of recentComparable) {
    const previousStartedAt = utcMs(previous.start_at);
    if (previousStartedAt === null) continue;
    const earlier = history.filter((trip) => utcMs(trip.end_at) !== null
      && utcMs(trip.end_at) < previousStartedAt);
    if (selectTripAdviceCandidate(previous, earlier)?.code === advice.code) return null;
  }
  return advice;
}
