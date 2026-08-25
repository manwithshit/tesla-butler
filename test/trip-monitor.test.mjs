import test from "node:test";
import assert from "node:assert/strict";
import { createTripDatabaseMonitor, TripTracker } from "../src/trip-monitor.mjs";

function drive(id, startAt, endAt, overrides = {}) {
  return {
    id,
    car_id: 1,
    start_at: startAt,
    end_at: endAt,
    start_lat: 30,
    start_lng: 120,
    end_lat: 30,
    end_lng: 120,
    distance_km: 8,
    duration_min: 15,
    estimated_kwh: 1.5,
    drawn_kwh: 1.8,
    regenerated_kwh: 0.3,
    energy_source: "power_integration",
    ...overrides
  };
}

test("the first check establishes a baseline without replaying old trips", () => {
  const tracker = new TripTracker();
  const events = tracker.reconcile({
    completed: [drive(8, "2026-08-25T06:00:00Z", "2026-08-25T06:30:00Z")],
    active: null
  }, "2026-08-25T09:00:00Z");

  assert.deepEqual(events, []);
  assert.equal(tracker.toJSON().last_processed_drive_id, 8);
});

test("a completed trip is pushed only after five quiet minutes", () => {
  const tracker = new TripTracker({ initialized: true, last_processed_drive_id: 8 });
  const completed = [
    drive(8, "2026-08-25T06:00:00Z", "2026-08-25T06:30:00Z"),
    drive(9, "2026-08-25T10:00:00Z", "2026-08-25T10:20:00Z")
  ];

  assert.deepEqual(tracker.reconcile({ completed, active: null }, "2026-08-25T10:24:59Z"), []);
  const events = tracker.reconcile({ completed, active: null }, "2026-08-25T10:25:00Z");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].trip.segment_ids, [9]);
  assert.equal(tracker.toJSON().last_processed_drive_id, 9);
});

test("a short stop followed by another active segment defers and later sends one merged trip", () => {
  const tracker = new TripTracker({ initialized: true, last_processed_drive_id: 8 });
  const first = drive(9, "2026-08-25T10:00:00Z", "2026-08-25T10:20:00Z", { distance_km: 0.3 });
  const active = {
    id: 10,
    car_id: 1,
    start_at: "2026-08-25T10:22:00Z",
    start_lat: 30,
    start_lng: 120
  };

  assert.deepEqual(tracker.reconcile({ completed: [first], active }, "2026-08-25T10:26:00Z"), []);
  const second = drive(10, active.start_at, "2026-08-25T10:40:00Z", { distance_km: 11.9 });
  const events = tracker.reconcile({ completed: [first, second], active: null }, "2026-08-25T10:45:00Z");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].trip.segment_ids, [9, 10]);
  assert.equal(events[0].trip.distance_km, 12.2);
});

test("the database monitor sends a stable trip once and persists acknowledgement", async () => {
  const sent = [];
  let saved = null;
  const tracker = new TripTracker({ initialized: true, last_processed_drive_id: 8 });
  const check = createTripDatabaseMonitor({
    tracker,
    getSnapshot: async () => ({
      completed: [
        drive(8, "2026-08-25T06:00:00Z", "2026-08-25T06:30:00Z"),
        drive(9, "2026-08-25T10:00:00Z", "2026-08-25T10:20:00Z")
      ],
      active: null
    }),
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => sent.push(event.trip.segment_ids),
    now: () => new Date("2026-08-25T10:25:00Z")
  });

  assert.equal((await check()).status, "delivered");
  assert.deepEqual(sent, [[9]]);
  assert.deepEqual(saved.pending_events, {});
  assert.equal((await check()).status, "unchanged");
  assert.equal(sent.length, 1);
});

test("a failed trip push survives Worker restart and retries", async () => {
  let saved = null;
  const snapshot = {
    completed: [drive(9, "2026-08-25T10:00:00Z", "2026-08-25T10:20:00Z")],
    active: null
  };
  const firstCheck = createTripDatabaseMonitor({
    tracker: new TripTracker({ initialized: true, last_processed_drive_id: 8 }),
    getSnapshot: async () => snapshot,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async () => { throw new Error("temporary Feishu failure"); },
    now: () => new Date("2026-08-25T10:25:00Z")
  });

  await assert.rejects(firstCheck(), /temporary Feishu failure/);
  assert.equal(Object.keys(saved.pending_events).length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /start_lat|start_lng|end_lat|end_lng/);

  const sent = [];
  const restartedCheck = createTripDatabaseMonitor({
    tracker: new TripTracker(saved),
    getSnapshot: async () => snapshot,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => sent.push(event.trip.segment_ids),
    now: () => new Date("2026-08-25T10:26:00Z")
  });

  assert.equal((await restartedCheck()).status, "delivered");
  assert.deepEqual(sent, [[9]]);
  assert.deepEqual(saved.pending_events, {});
});
