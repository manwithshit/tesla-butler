import test from "node:test";
import assert from "node:assert/strict";
import { parseBeijingFuelPricePage } from "../src/fuel-prices.mjs";

test("daily Beijing reference parser reads date and all three petrol grades", () => {
  const html = `
    <p>2026年08月25日<!-- -->，北京汽油、柴油每升最新价格如下：
    92号汽油为<!-- -->7.78<!-- -->元，95号汽油为<!-- -->8.29<!-- -->元，
    98号汽油为<!-- -->9.79<!-- -->元。</p>`;
  assert.deepEqual(parseBeijingFuelPricePage(html), {
    display_date: "2026-08-25",
    prices: { "92": 7.78, "95": 8.29, "98": 9.79 }
  });
});

test("daily fuel-price parser rejects incomplete pages", () => {
  assert.throws(() => parseBeijingFuelPricePage("92号汽油为7.78元"), /incomplete/);
});
