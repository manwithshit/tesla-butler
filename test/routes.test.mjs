import test from "node:test";
import assert from "node:assert/strict";
import { selectMainRoute } from "../src/routes.mjs";

function drive(id, start, end, distance = 10, endAt = `2026-08-${String(id).padStart(2, "0")}T10:00:00Z`) {
  return {
    id,
    start_lat: start.lat,
    start_lng: start.lng,
    end_lat: end.lat,
    end_lng: end.lng,
    start_road: start.road,
    end_road: end.road,
    distance_km: distance,
    end_at: endAt
  };
}

test("main route combines forward and reverse trips within 750 meters", () => {
  const a = { lat: 30.2000, lng: 120.2000, road: "金鸡路" };
  const b = { lat: 30.3000, lng: 120.3000, road: "新宁路" };
  const result = selectMainRoute([
    drive(1, a, b, 12),
    drive(2, { ...b, lat: 30.3004 }, { ...a, lng: 120.2004 }, 12.4),
    drive(3, { ...a, lat: 30.1997 }, { ...b, lng: 120.2998 }, 11.8)
  ]);
  assert.equal(result.trip_count, 3);
  assert.equal(result.distance_km, 36.2);
  assert.match(result.label, /金鸡路.*新宁路|新宁路.*金鸡路/);
  assert.equal(result.representative_drive_id, 3);
});

test("main route requires at least three repeated trips", () => {
  const a = { lat: 30.2, lng: 120.2, road: "金鸡路" };
  const b = { lat: 30.3, lng: 120.3, road: "新宁路" };
  assert.equal(selectMainRoute([drive(1, a, b), drive(2, b, a)]), null);
});

test("main route requires three repeats then ranks by accumulated distance", () => {
  const a = { lat: 30.2, lng: 120.2, road: "A路" };
  const b = { lat: 30.3, lng: 120.3, road: "B路" };
  const c = { lat: 31.2, lng: 121.2, road: "C路" };
  const d = { lat: 31.3, lng: 121.3, road: "D路" };
  const result = selectMainRoute([
    drive(1, a, b, 1), drive(2, b, a, 1), drive(3, a, b, 1), drive(7, b, a, 1),
    drive(4, c, d, 20), drive(5, d, c, 20), drive(6, c, d, 20)
  ]);
  assert.match(result.label, /C路.*D路|D路.*C路/);
  assert.equal(result.distance_km, 60);
  assert.equal(result.trip_count, 3);
});
