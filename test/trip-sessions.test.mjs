import test from "node:test";
import assert from "node:assert/strict";
import { groupDriveSegments } from "../src/trip-sessions.mjs";

function segment(id, startAt, endAt, overrides = {}) {
  return {
    id,
    car_id: 1,
    start_at: startAt,
    end_at: endAt,
    start_lat: 30,
    start_lng: 120,
    end_lat: 30,
    end_lng: 120,
    distance_km: 5,
    duration_min: 10,
    estimated_kwh: 1,
    drawn_kwh: 1.2,
    regenerated_kwh: 0.2,
    energy_source: "power_integration",
    ...overrides
  };
}

test("a brief roadside stop remains one user-visible trip", () => {
  const groups = groupDriveSegments([
    segment(9, "2026-08-25T08:15:25Z", "2026-08-25T08:24:16Z", { distance_km: 0.3, duration_min: 9 }),
    segment(10, "2026-08-25T08:24:24Z", "2026-08-25T08:53:48Z", { distance_km: 11.9, duration_min: 29 })
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].segment_ids, [9, 10]);
  assert.equal(groups[0].distance_km, 12.2);
  assert.equal(groups[0].duration_min, 38);
});

test("a long stop creates two user-visible trips", () => {
  const groups = groupDriveSegments([
    segment(8, "2026-08-25T05:57:48Z", "2026-08-25T06:31:35Z", { distance_km: 16.2 }),
    segment(9, "2026-08-25T08:15:25Z", "2026-08-25T08:24:16Z", { distance_km: 0.3 })
  ]);

  assert.deepEqual(groups.map((group) => group.segment_ids), [[8], [9]]);
});

test("a charging session always separates trips", () => {
  const groups = groupDriveSegments([
    segment(20, "2026-08-25T10:00:00Z", "2026-08-25T10:10:00Z"),
    segment(21, "2026-08-25T10:10:30Z", "2026-08-25T10:20:00Z", { charging_between: true })
  ]);

  assert.deepEqual(groups.map((group) => group.segment_ids), [[20], [21]]);
});

test("a merged trip does not understate energy when one segment is unknown", () => {
  const [group] = groupDriveSegments([
    segment(30, "2026-08-25T11:00:00Z", "2026-08-25T11:10:00Z"),
    segment(31, "2026-08-25T11:10:30Z", "2026-08-25T11:20:00Z", {
      estimated_kwh: null,
      drawn_kwh: null,
      regenerated_kwh: null,
      energy_source: "unavailable"
    })
  ]);

  assert.equal(group.estimated_kwh, null);
  assert.equal(group.drawn_kwh, null);
  assert.equal(group.regenerated_kwh, null);
});
