import { getRuntimeState } from "./store.mjs";
import { getDriveMonitorSnapshot } from "./teslamate.mjs";
import { TripSessionTracker } from "./trip-session.mjs";

const runtimeState = await getRuntimeState();
const persistedTripState = runtimeState.trip_monitor || {};
const before = JSON.stringify(persistedTripState);
const beforePending = Object.keys(persistedTripState.pending_events || {}).length;
const snapshot = await getDriveMonitorSnapshot();
const tracker = new TripSessionTracker(persistedTripState);

tracker.reconcile(snapshot, new Date().toISOString());
const dryRun = tracker.toJSON();
const latestCompletedId = Math.max(0, ...(snapshot.completed || []).map((drive) => Number(drive.id) || 0));

process.stdout.write(`${JSON.stringify({
  ok: true,
  initialized: dryRun.initialized,
  active_session: Boolean(dryRun.session),
  session_phase: dryRun.session?.phase || null,
  pending_events: Object.keys(dryRun.pending_events).length,
  would_queue_new_event: Object.keys(dryRun.pending_events).length > beforePending,
  last_processed_covers_latest: Number(dryRun.last_processed_drive_id) >= latestCompletedId,
  persisted_state_unchanged: before === JSON.stringify(persistedTripState)
})}\n`);
