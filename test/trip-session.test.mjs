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

test("one hour without activity queues the parked trip", () => {
  const tracker = parkedTracker();
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("11:20:00"));

  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(tracker.pendingEvents()[0].reason, "inactivity_timeout");
});

test("charging start is a strong finalization boundary", () => {
  const tracker = parkedTracker();
  tracker.observeChargingStarted(at("10:25:00"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.equal(tracker.toJSON().session.finalization_reason, "charging_started");
  assert.equal(tracker.toJSON().session.finalize_at, new Date(at("10:25:45")).toISOString());
});
