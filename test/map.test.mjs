import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildEnergySegments, renderRoutePreview, wgs84ToGcj02 } from "../src/map.mjs";

test("WGS-84 coordinates convert to GCJ-02 inside mainland China", () => {
  const converted = wgs84ToGcj02(39.913818, 116.397828);
  assert.ok(Math.abs(converted.lat - 39.91522) < 0.00002);
  assert.ok(Math.abs(converted.lng - 116.40407) < 0.00002);
});

test("route energy segments expose low, medium and high visual levels", () => {
  const route = Array.from({ length: 18 }, (_, index) => ({
    lat: 30 + index * 0.0001,
    lng: 120 + index * 0.0001,
    power_kw: index < 6 ? 3 : index < 12 ? 15 : 45,
    drive_id: 1
  }));
  const levels = new Set(buildEnergySegments(route).map((segment) => segment.level));
  assert.deepEqual(levels, new Set(["low", "medium", "high"]));
});

test("route preview renders a private local PNG without a fake route", async () => {
  const result = await renderRoutePreview([], "test-empty-route");
  assert.equal(result.hasRoute, false);
  const data = await fs.readFile(result.path);
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
});
