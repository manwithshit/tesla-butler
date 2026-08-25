const defaultPauseMs = 5 * 60 * 1000;
const defaultEndpointMeters = 100;

function timeMs(value) {
  const raw = String(value || "").trim();
  const normalized = raw && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw;
  const result = new Date(normalized).getTime();
  return Number.isFinite(result) ? result : null;
}

function radians(value) {
  return Number(value) * Math.PI / 180;
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const values = [aLat, aLng, bLat, bLng].map(Number);
  if (!values.every(Number.isFinite)) return Infinity;
  const [lat1, lng1, lat2, lng2] = values.map(radians);
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

function shouldMerge(previous, current, options) {
  if (String(previous.car_id) !== String(current.car_id) || current.charging_between) return false;
  const gap = timeMs(current.start_at) - timeMs(previous.end_at);
  return Number.isFinite(gap)
    && gap >= 0
    && gap < options.pauseMs
    && distanceMeters(previous.end_lat, previous.end_lng, current.start_lat, current.start_lng) <= options.endpointMeters;
}

export function canMergeDriveSegments(previous, current, options = {}) {
  return shouldMerge(previous, current, {
    pauseMs: options.pauseMs ?? defaultPauseMs,
    endpointMeters: options.endpointMeters ?? defaultEndpointMeters
  });
}

function sum(segments, field, decimals = 2) {
  return Number(segments.reduce((total, segment) => total + (Number(segment[field]) || 0), 0).toFixed(decimals));
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function aggregate(segments) {
  const first = segments[0];
  const last = segments.at(-1);
  const numericEnergy = segments.every((segment) => hasNumber(segment.estimated_kwh));
  return {
    id: last.id,
    car_id: last.car_id,
    segment_ids: segments.map((segment) => segment.id),
    start_at: first.start_at,
    end_at: last.end_at,
    start_road: first.start_road ?? null,
    end_road: last.end_road ?? null,
    start_lat: first.start_lat,
    start_lng: first.start_lng,
    end_lat: last.end_lat,
    end_lng: last.end_lng,
    distance_km: sum(segments, "distance_km", 1),
    duration_min: sum(segments, "duration_min"),
    estimated_kwh: numericEnergy ? sum(segments, "estimated_kwh") : null,
    drawn_kwh: segments.every((segment) => hasNumber(segment.drawn_kwh)) ? sum(segments, "drawn_kwh") : null,
    regenerated_kwh: segments.every((segment) => hasNumber(segment.regenerated_kwh)) ? sum(segments, "regenerated_kwh") : null,
    energy_source: segments.every((segment) => segment.energy_source === "power_integration")
      ? "power_integration"
      : "unavailable"
  };
}

export function groupDriveSegments(segments, options = {}) {
  const settings = {
    pauseMs: options.pauseMs ?? defaultPauseMs,
    endpointMeters: options.endpointMeters ?? defaultEndpointMeters
  };
  const sorted = [...(segments || [])]
    .filter((segment) => segment?.id && segment?.start_at && segment?.end_at)
    .sort((a, b) => timeMs(a.start_at) - timeMs(b.start_at));
  const groups = [];
  for (const segment of sorted) {
    const current = groups.at(-1);
    if (current && canMergeDriveSegments(current.at(-1), segment, settings)) current.push(segment);
    else groups.push([segment]);
  }
  return groups.map(aggregate);
}

export const tripSessionDefaults = Object.freeze({
  pauseMs: defaultPauseMs,
  endpointMeters: defaultEndpointMeters
});
