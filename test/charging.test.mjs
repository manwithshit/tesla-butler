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
