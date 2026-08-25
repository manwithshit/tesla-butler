import test from "node:test";
import assert from "node:assert/strict";
import { ChargingTracker, parseTeslaMateTopic } from "../src/charging.mjs";

test("TeslaMate MQTT topic parser accepts only supported charge fields", () => {
  assert.deepEqual(parseTeslaMateTopic("teslamate/cars/1/battery_level", "42"), {
    carId: "1", field: "battery_level", value: 42
  });
  assert.equal(parseTeslaMateTopic("teslamate/cars/1/location", "{}"), null);
});

test("charging tracker emits start and near-limit once per session", () => {
  const tracker = new ChargingTracker();
  tracker.update("1", "battery_level", 42, "2026-08-25T01:00:00Z");
  tracker.update("1", "charge_limit_soc", 80, "2026-08-25T01:00:01Z");
  tracker.update("1", "charger_power", 48.9, "2026-08-25T01:00:02Z");
  tracker.update("1", "time_to_full_charge", 0.6, "2026-08-25T01:00:03Z");
  const started = tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:04Z");
  assert.deepEqual(started.map((event) => event.type), ["started"]);

  const near = tracker.update("1", "time_to_full_charge", 0.25, "2026-08-25T01:20:00Z");
  assert.deepEqual(near.map((event) => event.type), ["near_limit"]);
  assert.equal(tracker.update("1", "battery_level", 78, "2026-08-25T01:21:00Z").length, 0);
});

test("charging tracker does not restart a session after a temporary stop", () => {
  const tracker = new ChargingTracker();
  assert.equal(tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:00Z").length, 1);
  assert.equal(tracker.update("1", "charging_state", "Stopped", "2026-08-25T01:10:00Z").length, 0);
  assert.equal(tracker.update("1", "charging_state", "Charging", "2026-08-25T01:20:00Z").length, 0);
  tracker.update("1", "charging_state", "Complete", "2026-08-25T02:00:00Z");
  assert.equal(tracker.update("1", "charging_state", "Charging", "2026-08-26T01:00:00Z").length, 1);
});

test("charging tracker falls back to five percent from configured limit", () => {
  const tracker = new ChargingTracker();
  tracker.update("1", "battery_level", 74, "2026-08-25T01:00:00Z");
  tracker.update("1", "charge_limit_soc", 80, "2026-08-25T01:00:01Z");
  tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:02Z");
  const near = tracker.update("1", "battery_level", 75, "2026-08-25T01:10:00Z");
  assert.deepEqual(near.map((event) => event.type), ["near_limit"]);
});

test("persisted charging state prevents duplicate pushes after restart", () => {
  const first = new ChargingTracker();
  first.update("1", "charging_state", "Charging", "2026-08-25T01:00:00Z");
  const restored = new ChargingTracker(first.toJSON());
  assert.equal(restored.update("1", "charging_state", "Charging", "2026-08-25T01:01:00Z").length, 0);
});

test("a stale ETA from an earlier session cannot trigger a new near-limit alert", () => {
  const tracker = new ChargingTracker();
  tracker.update("1", "time_to_full_charge", 0.1, "2026-08-24T01:00:00Z");
  const started = tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:00Z");
  assert.deepEqual(started.map((event) => event.type), ["started"]);
  assert.equal(started[0].snapshot.time_to_full_charge, undefined);

  const near = tracker.update("1", "time_to_full_charge", 0.1, "2026-08-25T01:00:01Z");
  assert.deepEqual(near.map((event) => event.type), ["near_limit"]);
});

test("a queued alert is cancelled when charging has already stopped", () => {
  const tracker = new ChargingTracker();
  tracker.update("1", "charge_limit_soc", 80, "2026-08-25T01:00:00Z");
  const [started] = tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:01Z");
  assert.equal(tracker.canSend(started, "2026-08-25T01:00:02Z"), true);

  tracker.update("1", "charging_state", "Complete", "2026-08-25T01:00:03Z");
  assert.equal(tracker.canSend(started, "2026-08-25T01:00:04Z"), false);
});

test("near-limit alerts require current-session data that is at most two minutes old", () => {
  const tracker = new ChargingTracker();
  tracker.update("1", "charge_limit_soc", 80, "2026-08-25T01:00:00Z");
  tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:01Z");
  const [near] = tracker.update("1", "time_to_full_charge", 0.2, "2026-08-25T01:00:02Z");
  assert.equal(tracker.canSend(near, "2026-08-25T01:02:01Z"), true);
  assert.equal(tracker.canSend(near, "2026-08-25T01:02:03Z"), false);
});

test("an active TeslaMate charging process emits one start notification and survives restart", () => {
  const process = {
    id: 12,
    car_id: 1,
    start_at: "2026-08-25T06:35:49Z",
    end_at: null,
    start_battery_level: 64,
    latest_battery_level: 70,
    latest_charger_power: 48,
    latest_charge_energy_added: 3.2
  };
  const tracker = new ChargingTracker();
  const started = tracker.reconcileProcess(process, "2026-08-25T06:36:30Z");
  assert.deepEqual(started.map((event) => event.type), ["started"]);
  assert.equal(started[0].snapshot.battery_level, 70);
  assert.equal(started[0].snapshot.charger_power, 48);
  assert.equal(started[0].snapshot.charge_energy_added, 3.2);
  assert.equal(tracker.reconcileProcess(process, "2026-08-25T06:37:30Z").length, 0);

  const restored = new ChargingTracker(tracker.toJSON());
  assert.equal(restored.reconcileProcess(process, "2026-08-25T06:38:30Z").length, 0);
});

test("a charging process changing from active to ended emits one completed notification", () => {
  const tracker = new ChargingTracker();
  tracker.reconcileProcess({
    id: 12,
    car_id: 1,
    start_at: "2026-08-25T06:35:49Z",
    end_at: null,
    start_battery_level: 64,
    latest_battery_level: 70
  }, "2026-08-25T06:36:30Z");

  const completedProcess = {
    id: 12,
    car_id: 1,
    start_at: "2026-08-25T06:35:49Z",
    end_at: "2026-08-25T06:56:39Z",
    start_battery_level: 64,
    end_battery_level: 97,
    charge_energy_added: 17,
    duration_min: 21
  };
  const completed = tracker.reconcileProcess(completedProcess, "2026-08-25T06:57:00Z");
  assert.deepEqual(completed.map((event) => event.type), ["completed"]);
  assert.equal(completed[0].snapshot.start_battery_level, 64);
  assert.equal(completed[0].snapshot.end_battery_level, 97);
  assert.equal(completed[0].snapshot.charge_energy_added, 17);
  assert.equal(completed[0].snapshot.duration_min, 21);
  assert.equal(tracker.canSend(completed[0], "2026-08-25T06:57:01Z"), true);
  assert.equal(tracker.reconcileProcess(completedProcess, "2026-08-25T06:58:00Z").length, 0);
});

test("a newly completed process is recovered even when it started and ended between polls", () => {
  const tracker = new ChargingTracker();
  const completed = tracker.reconcileProcess({
    id: 13,
    car_id: 1,
    start_at: "2026-08-25T07:00:00Z",
    end_at: "2026-08-25T07:00:40Z",
    start_battery_level: 70,
    end_battery_level: 72,
    charge_energy_added: 0.8,
    duration_min: 1
  }, "2026-08-25T07:01:00Z");
  assert.deepEqual(completed.map((event) => event.type), ["completed"]);
});

test("MQTT and PostgreSQL observations do not duplicate the same charging start", () => {
  const process = {
    id: 16,
    car_id: 1,
    start_at: "2026-08-25T10:00:00Z",
    end_at: null,
    start_battery_level: 50,
    latest_battery_level: 51
  };

  const mqttFirst = new ChargingTracker();
  const [mqttStarted] = mqttFirst.update("1", "charging_state", "Charging", "2026-08-25T10:00:01Z");
  mqttFirst.acknowledge(mqttStarted);
  assert.equal(mqttFirst.reconcileProcess(process, "2026-08-25T10:00:30Z").length, 0);
  assert.equal(mqttFirst.pendingEvents().length, 0);

  const databaseFirst = new ChargingTracker();
  const [databaseStarted] = databaseFirst.reconcileProcess(process, "2026-08-25T10:00:30Z");
  databaseFirst.acknowledge(databaseStarted);
  assert.equal(databaseFirst.update("1", "charging_state", "Charging", "2026-08-25T10:00:31Z").length, 0);
  assert.equal(databaseFirst.pendingEvents().length, 0);
});

test("worker startup does not replay an old completed charging process", () => {
  const tracker = new ChargingTracker();
  const events = tracker.reconcileProcess({
    id: 2,
    car_id: 1,
    start_at: "2026-08-25T06:35:49Z",
    end_at: "2026-08-25T06:56:39Z",
    start_battery_level: 64,
    end_battery_level: 97,
    charge_energy_added: 17,
    duration_min: 21
  }, "2026-08-25T07:10:00Z");
  assert.equal(events.length, 0);
  assert.equal(tracker.pendingEvents().length, 0);
});
