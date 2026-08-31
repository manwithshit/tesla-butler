import test from "node:test";
import assert from "node:assert/strict";
import { calculateFuelComparisons, calculateTripElectricCost } from "../src/comparisons.mjs";

const reference = Object.freeze({
  prices: { "92": 7.78, "95": 8.29, "98": 9.79 },
  price_scope: "北京统一参考基准",
  price_source: "test fixture",
  effective_date: "2026-08-31",
  is_current_day: true
});

test("fuel comparisons preserve the five agreed consumption tiers", () => {
  const result = calculateFuelComparisons(100, 10, { reference });
  assert.deepEqual(result.items.map((item) => item.name), ["日产轩逸", "宝马5系", "路虎卫士", "保时捷911", "兰博基尼超跑"]);
  assert.deepEqual(result.items.map((item) => item.model_spec), ["十五代轩逸", "BMW 530Li", "卫士 110 P400", "911 GT3", "Aventador S Roadster（经典停产）"]);
  assert.deepEqual(result.items.map((item) => item.consumption), [5.88, 6.70, 11.27, 12.70, 19.20]);
  assert.deepEqual(result.items.map((item) => item.liters), [5.88, 6.70, 11.27, 12.70, 19.20]);
  assert.ok(result.items.every((item) => item.cost_cny >= 0));
});

test("oil-car savings use trip energy cost instead of the whole charging receipt", () => {
  assert.equal(calculateTripElectricCost(2.27, 1.39), 3.16);
  assert.equal(calculateTripElectricCost(null, 1.39), null);
  assert.equal(calculateTripElectricCost(2.27, null), null);

  const result = calculateFuelComparisons(9.4, calculateTripElectricCost(2.27, 1.39), { reference });
  assert.equal(result.items[0].saving_cny, 1.14);
});

test("fuel comparison uses an injected daily reference instead of demo prices", () => {
  const result = calculateFuelComparisons(100, 0, { reference });
  assert.equal(result.price_scope, "北京统一参考基准");
  assert.equal(result.is_demo_price, false);
  assert.deepEqual(result.prices, { "92": 7.78, "95": 8.29, "98": 9.79 });
});
