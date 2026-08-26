export { TripSessionTracker as TripTracker } from "./trip-session.mjs";

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
    tracker.acknowledge(event);
    await saveState(tracker.toJSON());
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
  timeoutMs = 3_000
}) {
  let running = false;
  return async function checkTripDatabase() {
    if (running) return { status: "busy", events: 0 };
    running = true;
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`trip database check timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const snapshot = await Promise.race([getSnapshot(), timeout]).finally(() => clearTimeout(timer));
      const before = JSON.stringify(tracker.toJSON());
      tracker.reconcile(snapshot, now().toISOString());
      if (JSON.stringify(tracker.toJSON()) !== before) await saveState(tracker.toJSON());
      return deliverPendingTripEvents({ tracker, getTrip, getRuntimeState, saveState, sendTrip });
    } finally {
      running = false;
    }
  };
}
