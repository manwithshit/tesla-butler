export { TripSessionTracker as TripTracker } from "./trip-session.mjs";
import { replayVehicleSignals } from './signal-replay.mjs';
import { withQueryDeadline } from './query-runtime.mjs';

export async function deliverPendingTripEvents({ tracker, getTrip, getRuntimeState, saveState, sendTrip }) {
  const events = tracker.pendingEvents();
  if (events.length === 0) return { status: "unchanged", events: 0 };
  const state = await getRuntimeState();
  if (!state.chat_id) return { status: "no_chat", events: events.length };
  let delivered = 0;
  for (const event of events) {
    const trip = event.trip || await getTrip?.(event.segment_ids);
    if (!trip) throw new Error("trip hydration failed");
    const deliveryEvent = { ...event, trip };
    await sendTrip(state.chat_id, deliveryEvent, event.tripId);
    const beforeAck = tracker.toJSON();
    tracker.acknowledge(event);
    try { await saveState(tracker.toJSON()); }
    catch (error) { tracker.restore(beforeAck); throw error; }
    delivered += 1;
  }
  return { status: "delivered", events: delivered };
}

export function createTripDatabaseMonitor({
  tracker,
  getSnapshot,
  getTrip,
  getRuntimeState,
  saveState,
  sendTrip,
  now = () => new Date(),
  timeoutMs = 10_000
}) {
  let running = false;
  return async function checkTripDatabase() {
    if (running) return { status: "busy", events: 0 };
    running = true;
    try {
      const snapshot = await withQueryDeadline(getSnapshot, timeoutMs, 'trip database check');
      const beforeState = tracker.toJSON();
      const before = JSON.stringify(beforeState);
      const state = await getRuntimeState();
      const observedAt = now().toISOString();
      try {
        const signalIds = replayVehicleSignals(tracker, snapshot, state.trip_signal_inbox || [], observedAt);
        tracker.reconcile(snapshot, observedAt);
        if (signalIds.length || JSON.stringify(tracker.toJSON()) !== before) {
          await saveState(tracker.toJSON(), { signalIds });
        }
      } catch (error) { tracker.restore(beforeState); throw error; }
      return deliverPendingTripEvents({ tracker, getTrip, getRuntimeState, saveState, sendTrip });
    } finally {
      running = false;
    }
  };
}
