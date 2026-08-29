import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTripState, TripSessionTracker } from "../src/trip-session.mjs";

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

test("trip state summaries expose only aggregate transition evidence", () => {
  const tracker = parkedTracker();
  const summary = summarizeTripState(tracker.toJSON());

  assert.deepEqual(summary, {
    phase: "parked",
    segment_count: 1,
    pending_count: 0,
    reason: "none",
    active: false,
    boundary_stage: "none"
  });
  assert.doesNotMatch(JSON.stringify(summary), /10:20|segment_ids|last_processed/);
});

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

test("door and lock signals survive database lag and finalize the completed continuation", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:20:30"));

  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:50:00"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:50:01"));
  tracker.observeVehicleSignal("locked", true, at("10:50:03"));
  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.pendingEvents(), []);

  tracker.reconcile({
    completed: [
      completedDrive(10),
      completedDrive(11, "10:20:30", "10:49:59")
    ],
    active: null
  }, at("10:50:04"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.equal(tracker.toJSON().session.finalization_reason, "locked");
  tracker.reconcile({
    completed: [completedDrive(10), completedDrive(11, "10:20:30", "10:49:59")],
    active: null
  }, at("10:50:48"));
  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[10, 11]]);
});

test("a vanished active drive cannot finalize against the previous completed segment", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:20:30"));
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:50:00"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:50:01"));
  tracker.observeVehicleSignal("locked", true, at("10:50:03"));

  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:50:50"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.deepEqual(tracker.pendingEvents(), []);

  tracker.reconcile({
    completed: [
      completedDrive(10),
      completedDrive(11, "10:20:30", "10:49:59")
    ],
    active: null
  }, at("10:51:00"));
  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[10, 11]]);
});

test("a door and lock sequence before the database end cannot finalize the trip", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:10:00"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:10:01"));
  tracker.observeVehicleSignal("locked", true, at("10:10:02"));

  tracker.reconcile({
    completed: [completedDrive(10, "10:00:00", "10:20:00")],
    active: null
  }, at("10:20:01"));

  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.equal(tracker.toJSON().session.boundary_candidate, null);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a database-lag boundary candidate survives restart without duplicate delivery", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:00"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:01"));
  tracker.observeVehicleSignal("locked", true, at("10:20:02"));

  const restored = new TripSessionTracker(tracker.toJSON());
  restored.reconcile({
    completed: [completedDrive(10, "10:00:00", "10:19:59")],
    active: null
  }, at("10:20:03"));
  restored.reconcile({
    completed: [completedDrive(10, "10:00:00", "10:19:59")],
    active: null
  }, at("10:20:47"));

  assert.deepEqual(restored.pendingEvents().map((event) => event.segment_ids), [[10]]);
  const [event] = restored.pendingEvents();
  restored.acknowledge(event, at("10:20:48"));
  const restartedAgain = new TripSessionTracker(restored.toJSON());
  restartedAgain.reconcile({
    completed: [completedDrive(10, "10:00:00", "10:19:59")],
    active: null
  }, at("10:21:00"));
  assert.deepEqual(restartedAgain.pendingEvents(), []);
});

test("a legacy driving session learns the authoritative active start after restart", () => {
  const tracker = new TripSessionTracker({
    version: 2,
    initialized: true,
    last_processed_drive_id: 9,
    session: {
      phase: "driving",
      segment_ids: [9],
      started_at: at("10:00:05"),
      last_event_at: at("10:00:05"),
      parked_at: at("09:59:00"),
      finalize_at: null,
      finalization_reason: null
    }
  });

  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:06"));

  assert.equal(tracker.toJSON().session.active_started_at, at("10:00:00"));
  assert.deepEqual(tracker.pendingEvents(), []);
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

test("a lock edge without an existing trip session is a no-op", () => {
  const tracker = initializedTracker();
  tracker.observeVehicleSignal("locked", false, at("10:20:00"), { retained: true });
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));

  assert.equal(tracker.toJSON().session, null);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a fresh lock finalizes an existing parked unsent trip when the door edge was missed", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.equal(tracker.toJSON().session.finalization_reason, "locked_parallel");
  assert.deepEqual(tracker.pendingEvents(), []);
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:48"));
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:21:03"));
  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(tracker.pendingEvents()[0].reason, "locked_parallel");
});

test("driving resumed during parallel-lock confirmation keeps the same trip", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:20:30"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a stale incomplete door candidate cannot block a valid parked lock fallback", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:10:00"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:10:01"));
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:20:01"));
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));

  assert.equal(tracker.toJSON().session.phase, "finalizing");
  assert.equal(tracker.toJSON().session.finalization_reason, "locked_parallel");
});

test("a lock edge long after parking does not use the fast parallel boundary", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("locked", true, at("10:30:01"));

  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.equal(tracker.toJSON().session.finalization_reason, null);
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

test("an unlocked stop followed by driving within thirty minutes stays one session", () => {
  const tracker = parkedTracker();
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:49:59") }
  }, at("10:49:59"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("resuming driving clears an incomplete boundary candidate", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));

  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:05") }
  }, at("10:20:05"));

  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.equal(tracker.toJSON().session.boundary_candidate, null);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("an active continuation suppresses the parked timeout even after one hour", () => {
  const tracker = parkedTracker();
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("11:20:01"));

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

test("thirty minutes parked without a continuation queues the trip", () => {
  const tracker = parkedTracker();
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:50:00"));

  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(tracker.pendingEvents()[0].reason, "inactivity_timeout");
});

test("ignored MQTT changes cannot postpone the parked timeout", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:49:00"));
  tracker.reconcile({ completed: [completedDrive(10)], active: null }, at("10:50:00"));

  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(tracker.pendingEvents()[0].reason, "inactivity_timeout");
});

test("a newly completed continuation is absorbed before the parked timeout is evaluated", () => {
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 9 });
  tracker.reconcile({
    completed: [completedDrive(10, "07:49:17", "07:50:08")],
    active: null
  }, at("07:50:09"));

  tracker.reconcile({
    completed: [
      completedDrive(10, "07:49:17", "07:50:08"),
      completedDrive(11, "07:50:56", "08:58:12")
    ],
    active: null
  }, at("08:58:13"));

  assert.deepEqual(tracker.pendingEvents(), []);
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10, 11]);
  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.equal(tracker.toJSON().session.last_event_at, at("08:58:12"));
});

test("recovered database segments thirty minutes apart form separate sessions", () => {
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  tracker.reconcile({
    completed: [
      completedDrive(9, "10:00:00", "10:20:00"),
      completedDrive(10, "10:50:00", "11:00:00")
    ],
    active: null
  }, at("11:00:01"));

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

test("charging finalization waits for the currently active database segment", () => {
  const tracker = parkedTracker();
  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:20:30"));
  tracker.observeChargingStarted(at("10:50:00"));

  tracker.reconcile({
    completed: [completedDrive(10)],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:50:01"));
  assert.deepEqual(tracker.pendingEvents(), []);
  assert.equal(tracker.toJSON().session.phase, "finalizing");

  tracker.reconcile({
    completed: [
      completedDrive(10),
      completedDrive(11, "10:20:30", "10:49:59")
    ],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:50:45"));
  assert.deepEqual(tracker.pendingEvents(), []);

  tracker.reconcile({
    completed: [
      completedDrive(10),
      completedDrive(11, "10:20:30", "10:49:59")
    ],
    active: { id: 11, start_at: at("10:20:30") }
  }, at("10:50:46"));
  assert.deepEqual(tracker.pendingEvents(), []);

  tracker.reconcile({
    completed: [
      completedDrive(10),
      completedDrive(11, "10:20:30", "10:49:59")
    ],
    active: null
  }, at("10:50:47"));
  assert.deepEqual(tracker.pendingEvents().map((event) => event.segment_ids), [[10, 11]]);
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
