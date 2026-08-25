import { canMergeDriveSegments, groupDriveSegments, tripSessionDefaults } from "./trip-sessions.mjs";

function latestDriveId(completed) {
  return Math.max(0, ...(completed || []).map((drive) => Number(drive.id) || 0));
}

function timeMs(value) {
  const raw = String(value || "").trim();
  const normalized = raw && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw;
  const result = new Date(normalized).getTime();
  return Number.isFinite(result) ? result : null;
}

function safeTrip(group) {
  return {
    id: group.id,
    car_id: group.car_id,
    segment_ids: [...group.segment_ids],
    start_at: group.start_at,
    end_at: group.end_at,
    start_road: group.start_road,
    end_road: group.end_road,
    distance_km: group.distance_km,
    duration_min: group.duration_min,
    estimated_kwh: group.estimated_kwh,
    drawn_kwh: group.drawn_kwh,
    regenerated_kwh: group.regenerated_kwh,
    energy_source: group.energy_source
  };
}

export class TripTracker {
  constructor(saved = {}) {
    this.initialized = Boolean(saved.initialized);
    this.lastProcessedDriveId = Number(saved.last_processed_drive_id) || 0;
    this.pendingEventsByKey = new Map(Object.entries(saved.pending_events || {}));
  }

  reconcile(snapshot, at = new Date().toISOString()) {
    const completed = snapshot?.completed || [];
    if (!this.initialized) {
      this.initialized = true;
      this.lastProcessedDriveId = latestDriveId(completed);
      return [];
    }
    const groups = groupDriveSegments(completed);
    const newGroups = groups.filter((group) => Math.max(...group.segment_ids.map(Number)) > this.lastProcessedDriveId);
    const nowMs = timeMs(at);
    const events = [];
    for (const [index, group] of newGroups.entries()) {
      const isLatestOverall = group === groups.at(-1);
      const quietLongEnough = nowMs !== null
        && timeMs(group.end_at) !== null
        && nowMs - timeMs(group.end_at) >= tripSessionDefaults.pauseMs;
      const activeContinuesGroup = isLatestOverall
        && snapshot?.active
        && canMergeDriveSegments(group, snapshot.active);
      if (isLatestOverall && (!quietLongEnough || activeContinuesGroup)) continue;
      const lastId = Math.max(...group.segment_ids.map(Number));
      const eventKey = `trip-${group.segment_ids.join("-")}`;
      const event = { type: "completed_trip", eventKey, tripId: eventKey, trip: safeTrip(group) };
      this.pendingEventsByKey.set(eventKey, event);
      this.lastProcessedDriveId = Math.max(this.lastProcessedDriveId, lastId);
      events.push(event);
    }
    return events;
  }

  pendingEvents() {
    return [...this.pendingEventsByKey.values()].map((event) => ({
      ...event,
      trip: { ...event.trip, segment_ids: [...event.trip.segment_ids] }
    }));
  }

  acknowledge(event) {
    if (event?.eventKey) this.pendingEventsByKey.delete(event.eventKey);
  }

  toJSON() {
    return {
      initialized: this.initialized,
      last_processed_drive_id: this.lastProcessedDriveId,
      pending_events: Object.fromEntries(this.pendingEventsByKey)
    };
  }
}

export async function deliverPendingTripEvents({ tracker, getRuntimeState, saveState, sendTrip }) {
  const events = tracker.pendingEvents();
  if (events.length === 0) return { status: "unchanged", events: 0 };
  const state = await getRuntimeState();
  if (!state.chat_id) return { status: "no_chat", events: events.length };
  let delivered = 0;
  for (const event of events) {
    await sendTrip(state.chat_id, event, event.tripId);
    tracker.acknowledge(event);
    await saveState(tracker.toJSON());
    delivered += 1;
  }
  return { status: "delivered", events: delivered };
}

export function createTripDatabaseMonitor({
  tracker,
  getSnapshot,
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
      return deliverPendingTripEvents({ tracker, getRuntimeState, saveState, sendTrip });
    } finally {
      running = false;
    }
  };
}

export { groupDriveSegments, tripSessionDefaults };
