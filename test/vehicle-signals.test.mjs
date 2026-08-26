import test from "node:test";
import assert from "node:assert/strict";
import { parseVehicleSignalTopic, tripSignalTopics } from "../src/vehicle-signals.mjs";

test("only door and lock boolean topics become trip signals", () => {
  assert.deepEqual(
    parseVehicleSignalTopic("teslamate/cars/unit-test/locked", "true"),
    { field: "locked", value: true }
  );
  assert.deepEqual(
    parseVehicleSignalTopic("teslamate/cars/unit-test/driver_front_door_open", "false"),
    { field: "driver_front_door_open", value: false }
  );
  assert.equal(parseVehicleSignalTopic("teslamate/cars/unit-test/locked", "unknown"), null);
  assert.equal(parseVehicleSignalTopic("teslamate/cars/unit-test/shift_state", "P"), null);
  assert.deepEqual(tripSignalTopics, [
    "teslamate/cars/+/locked",
    "teslamate/cars/+/driver_front_door_open"
  ]);
});
