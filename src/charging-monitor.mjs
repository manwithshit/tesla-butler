export async function deliverPendingChargingEvents({
  tracker,
  getRuntimeState,
  saveState,
  sendEvent,
  at = new Date().toISOString()
}) {
  const events = tracker.pendingEvents();
  if (events.length === 0) return { status: "unchanged", events: 0 };
  const state = await getRuntimeState();
  if (!state.chat_id) return { status: "no_chat", events: events.length };
  let delivered = 0;
  let discarded = 0;
  for (const event of events) {
    if (!tracker.canSend(event, at)) {
      tracker.acknowledge(event);
      await saveState(tracker.toJSON());
      discarded += 1;
      continue;
    }
    await sendEvent(state.chat_id, event, event.sessionId);
    tracker.acknowledge(event);
    await saveState(tracker.toJSON());
    delivered += 1;
  }
  return {
    status: delivered > 0 ? "delivered" : "discarded",
    events: delivered,
    discarded
  };
}

export function createChargingDatabaseMonitor({
  tracker,
  getLatestProcess,
  getRuntimeState,
  saveState,
  sendEvent,
  now = () => new Date(),
  timeoutMs = 3_000
}) {
  let running = false;
  return async function checkChargingDatabase() {
    if (running) return { status: "busy", events: 0 };
    running = true;
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`charging database check timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const process = await Promise.race([getLatestProcess(), timeout]).finally(() => clearTimeout(timer));
      const observedAt = now().toISOString();
      const before = JSON.stringify(tracker.toJSON());
      if (process) tracker.reconcileProcess(process, observedAt);
      if (JSON.stringify(tracker.toJSON()) !== before) {
        await saveState(tracker.toJSON());
      }
      const result = await deliverPendingChargingEvents({
        tracker,
        getRuntimeState,
        saveState,
        sendEvent,
        at: observedAt
      });
      if (result.status === "unchanged" && !process) return { status: "empty", events: 0 };
      return result;
    } finally {
      running = false;
    }
  };
}
