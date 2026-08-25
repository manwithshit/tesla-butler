import { assertCard, buildLatestTripCard } from "./cards.mjs";
import { getDriveGroupRoute, getDriveMonitorSnapshot, getLatestTripGroup } from "./teslamate.mjs";
import { TripTracker } from "./trip-monitor.mjs";

const startedAt = performance.now();
const snapshot = await getDriveMonitorSnapshot();
const queryMs = Math.round((performance.now() - startedAt) * 10) / 10;
if (queryMs >= 3_000) throw new Error(`trip monitor query is too slow: ${queryMs}ms`);

const tracker = new TripTracker();
const replayEvents = tracker.reconcile(snapshot, new Date().toISOString()).length;
if (replayEvents !== 0) throw new Error("trip monitor would replay existing history on first startup");
if (/start_lat|start_lng|end_lat|end_lng/.test(JSON.stringify(tracker.toJSON()))) {
  throw new Error("trip monitor persistence contains precise coordinates");
}

const latest = await getLatestTripGroup();
let routePoints = 0;
let cardBlocks = null;
if (latest) {
  const route = await getDriveGroupRoute(latest.segment_ids);
  routePoints = route.length;
  if (routePoints < 2) throw new Error("latest trip route is unavailable");
  cardBlocks = assertCard(buildLatestTripCard(latest, "test-image-key", true, {
    hasBasemap: true,
    hasEnergyOverlay: true
  })).body.elements.length;
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  query_ms: queryMs,
  completed_segments: snapshot.completed.length,
  active_drive: Boolean(snapshot.active),
  latest_trip: latest ? {
    segment_count: latest.segment_ids.length,
    distance_km: latest.distance_km,
    duration_min: latest.duration_min,
    estimated_kwh: latest.estimated_kwh,
    route_points: routePoints,
    card_blocks: cardBlocks
  } : null,
  startup_replay_events: replayEvents
}, null, 2)}\n`);
