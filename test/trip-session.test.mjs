import test from "node:test";
import assert from "node:assert/strict";
import { TripSessionTracker } from "../src/trip-session.mjs";

const at = (time) => `2026-08-26T${time}Z`;

function activeDrive(id) {
  return { id, start_at: at("10:00:00") };
}

function completedDrive(id, startTime = "10:00:00", endTime = "10:20:00") {
  return { id, start_at: at(startTime), end_at: at(endTime) };
}

function initializedTracker() {
  return new TripSessionTracker({ initialized: true, last_processed_drive_id: 9 });
}

function parkedTracker() {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:00"));
  return tracker;
}

function baselineUnlockedAndDoorClosed(tracker) {
  tracker.observeVehicleSignal("locked", false, at("10:20:00"), { retained: true });
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:00"), { retained: true });
}

test("driving starts a session and ignores automatic locking", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  tracker.observeVehicleSignal("locked", false, at("10:00:01"), { retained: true });
  tracker.observeVehicleSignal("locked", true, at("10:00:02"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a completed database segment parks the active session", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:01"));

  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.equal(tracker.toJSON().last_processed_drive_id, 10);
});

test("parked door open close and new lock finalizes exactly once", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:47"));
  assert.equal(tracker.pendingEvents().length, 0);
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:48"));
  assert.equal(tracker.pendingEvents().length, 1);
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:21:03"));
  assert.equal(tracker.pendingEvents().length, 1);
});

test("a new active drive after confirmed locking starts a separate session", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:10") }
  }, at("10:20:10"));

  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[10]]);
  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, []);
});

test("retained locked true only initializes the parked baseline", () => {
  const tracker = parkedTracker();
  tracker.observeVehicleSignal("locked", true, at("10:20:01"), { retained: true });

  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a lock without the door sequence does not finalize", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));

  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a door sequence without a new lock does not finalize", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));

  assert.equal(tracker.toJSON().session.phase, "door_closed");
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("an unlocked stop followed by driving within one hour stays one session", () => {
  const tracker = parkedTracker();
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:50:00") }
  }, at("10:50:00"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a completed segment and resumed active drive in one poll remain driving", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:21:00") }
  }, at("10:21:01"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
});

test("one hour without activity queues the parked trip", () => {
  const tracker = parkedTracker();
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("11:20:00"));

  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(tracker.pendingEvents()[0].reason, "inactivity_timeout");
});

test("recovered database segments one hour apart form separate sessions", () => {
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  tracker.reconcile({
    completed: [
      completedDrive(9, "10:00:00", "10:20:00"),
      completedDrive(10, "11:20:00", "11:30:00")
    ],
    active: null
  }, at("11:30:01"));

  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[9]]);
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
});

test("database charging evidence separates recovered drive segments", () => {
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  tracker.reconcile({
    completed: [
      completedDrive(9, "10:00:00", "10:20:00"),
      { ...completedDrive(10, "10:30:00", "10:45:00"), charging_between: true }
    ],
    active: null
  }, at("10:45:01"));

  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[9]]);
  assert.equal(tracker.pendingEvents()[0].reason, "charging_between");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
});

test("charging start is a strong finalization boundary", () => {
  const tracker = parkedTracker();
  tracker.observeChargingStarted(at("10:25:00"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.equal(tracker.toJSON().session.finalization_reason, "charging_started");
  assert.equal(tracker.toJSON().session.finalize_at, new Date(at("10:25:45")).toISOString());
});

test("a database segment arriving during charging finalization keeps the boundary", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  tracker.observeChargingStarted(at("10:20:00"));
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:01"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.equal(tracker.toJSON().session.finalization_reason, "charging_started");
});

test("acknowledgement persists one sent key and prevents requeue after restart", () => {
  const tracker = parkedTracker();
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("11:20:00"));
  const [event] = tracker.pendingEvents();
  tracker.acknowledge(event);

  const restored = new TripSessionTracker(tracker.toJSON());
  restored.reconcile({ completed: [completedDrive(10)], active: null }, at("11:21:00"));
  assert.deepEqual(restored.pendingEvents(), []);
  assert.deepEqual(Object.keys(restored.toJSON().sent_keys), [event.eventKey]);
});

test("legacy pending trips migrate to segment-only persisted events", () => {
  const tracker = new TripSessionTracker({
    initialized: true,
    last_processed_drive_id: 10,
    pending_events: {
      "trip-10": {
        type: "completed_trip",
        eventKey: "trip-10",
        tripId: "trip-10",
        trip: { segment_ids: [10], start_road: "legacy road field" }
      }
    }
  });

  assert.deepEqual(tracker.pendingEvents()[0].segment_ids, [10]);
  assert.equal(tracker.pendingEvents()[0].trip, undefined);
  assert.doesNotMatch(JSON.stringify(tracker.toJSON()), /legacy road field/);
});
