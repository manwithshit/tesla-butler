import test from "node:test";
import assert from "node:assert/strict";
import { integratePowerSamples } from "../src/energy.mjs";

test("power integration returns net battery energy including regenerative braking", () => {
  const result = integratePowerSamples([
    { at: "2026-08-24T11:00:00.000Z", power_kw: 10 },
    { at: "2026-08-24T11:00:01.000Z", power_kw: 20 },
    { at: "2026-08-24T11:00:02.000Z", power_kw: -10 }
  ]);

  assert.deepEqual(result, {
    estimated_kwh: 0.006,
    drawn_kwh: 0.006,
    regenerated_kwh: 0,
    energy_source: "power_integration",
    valid_segments: 2
  });
});

test("power integration ignores telemetry gaps longer than ten seconds", () => {
  const result = integratePowerSamples([
    { at: "2026-08-24T11:00:00.000Z", power_kw: 10 },
    { at: "2026-08-24T11:01:00.000Z", power_kw: 10 }
  ]);

  assert.equal(result.estimated_kwh, null);
  assert.equal(result.energy_source, "unavailable");
  assert.equal(result.valid_segments, 0);
});
