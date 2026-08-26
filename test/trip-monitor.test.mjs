import test from "node:test";
import assert from "node:assert/strict";
import { createTripDatabaseMonitor } from "../src/trip-monitor.mjs";
import { TripSessionTracker } from "../src/trip-session.mjs";

function drive(id, startAt = "2026-08-26T10:00:00Z", endAt = "2026-08-26T10:20:00Z") {
  return { id, start_at: startAt, end_at: endAt };
}

function pendingState() {
  return {
    initialized: true,
    last_processed_drive_id: 9,
    pending_events: {
      "trip-9": {
        type: "completed_trip",
        eventKey: "trip-9",
        tripId: "trip-9",
        segment_ids: [9],
        reason: "locked"
      }
    }
  };
}

function monitorOptions(overrides = {}) {
  return {
    getSnapshot: async () => ({ completed: [drive(9)], active: null }),
    getTrip: async (segmentIds) => ({
      segment_ids: [...segmentIds],
      start_at: "2026-08-26T10:00:00Z",
      end_at: "2026-08-26T10:20:00Z"
    }),
    getRuntimeState: async () => ({ chat_id: "registered-chat" }),
    saveState: async () => {},
    sendTrip: async () => {},
    now: () => new Date("2026-08-26T10:20:01Z"),
    ...overrides
  };
}

test("the first database check establishes a baseline without replaying history", async () => {
  const sent = [];
  const tracker = new TripSessionTracker();
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    sendTrip: async (_chatId, event) => sent.push(event)
  }));

  assert.equal((await check()).status, "unchanged");
  assert.deepEqual(sent, []);
  assert.equal(tracker.toJSON().last_processed_drive_id, 9);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a newly completed segment persists a parked session without early delivery", async () => {
  const saved = [];
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    saveState: async (state) => saved.push(structuredClone(state))
  }));

  assert.equal((await check()).status, "unchanged");
  assert.equal(saved.at(-1).session.phase, "parked");
  assert.deepEqual(saved.at(-1).session.segment_ids, [9]);
  assert.deepEqual(saved.at(-1).pending_events, {});
});

test("a pending session is hydrated, delivered, and acknowledged exactly once", async () => {
  const delivered = [];
  let saved = null;
  const tracker = new TripSessionTracker(pendingState());
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => delivered.push(event.trip.segment_ids)
  }));

  assert.equal((await check()).status, "delivered");
  assert.equal((await check()).status, "unchanged");
  assert.deepEqual(delivered, [[9]]);
  assert.deepEqual(saved.pending_events, {});
  assert.deepEqual(Object.keys(saved.sent_keys), ["trip-9"]);
});

test("failed session delivery keeps segment-only pending and hydrates once per retry", async () => {
  let getTripCalls = 0;
  const getTrip = async (segmentIds) => {
    getTripCalls += 1;
    return { segment_ids: [...segmentIds], start_at: "2026-08-26T10:00:00Z", end_at: "2026-08-26T10:20:00Z" };
  };
  const tracker = new TripSessionTracker(pendingState());
  const failedCheck = createTripDatabaseMonitor(monitorOptions({
    tracker,
    getTrip,
    sendTrip: async () => { throw new Error("temporary Feishu failure"); }
  }));

  await assert.rejects(failedCheck(), /temporary Feishu failure/);
  assert.equal(getTripCalls, 1);
  assert.deepEqual(tracker.pendingEvents()[0].segment_ids, [9]);
  assert.equal(tracker.pendingEvents()[0].trip, undefined);

  const restored = new TripSessionTracker(tracker.toJSON());
  const delivered = [];
  let saved = null;
  const successfulCheck = createTripDatabaseMonitor(monitorOptions({
    tracker: restored,
    getTrip,
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => delivered.push(event.trip.segment_ids)
  }));

  assert.equal((await successfulCheck()).status, "delivered");
  assert.deepEqual(delivered, [[9]]);
  assert.equal(getTripCalls, 2);
  assert.deepEqual(saved.pending_events, {});
  assert.deepEqual(Object.keys(saved.sent_keys), ["trip-9"]);
});
