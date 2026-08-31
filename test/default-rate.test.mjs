import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDefaultElectricityRate,
  parseDefaultElectricityRate,
  parseDefaultRateFormValue,
  parseDefaultRateTextCommand
} from "../src/default-rate.mjs";

test("default electricity rate accepts a plain decimal from zero through ten", () => {
  assert.equal(parseDefaultElectricityRate("0"), 0);
  assert.equal(parseDefaultElectricityRate("0.6088"), 0.6088);
  assert.equal(parseDefaultElectricityRate("10"), 10);
});

test("default electricity rate rejects ambiguous or unsafe numeric formats", () => {
  for (const value of ["", "-1", "10.01", "0.12345", "1e-2", "0,60", "NaN", "0.60元/度"]) {
    assert.equal(parseDefaultElectricityRate(value), null, value);
  }
});

test("form parsing reads only the named default-rate input", () => {
  assert.equal(parseDefaultRateFormValue('{"default_rate":"0.60"}'), 0.6);
  assert.equal(parseDefaultRateFormValue({ default_rate: "1.2345" }), 1.2345);
  assert.equal(parseDefaultRateFormValue('{"other":"0.60"}'), null);
  assert.equal(parseDefaultRateFormValue("not-json"), null);
});

test("text fallback requires an explicit electricity-price phrase", () => {
  assert.equal(parseDefaultRateTextCommand("设置默认电价 0.60 元/度"), 0.6);
  assert.equal(parseDefaultRateTextCommand("家庭电价：0.5583"), 0.5583);
  assert.equal(parseDefaultRateTextCommand("默认电价 0.60？"), null);
  assert.equal(parseDefaultRateTextCommand("默认电价 0.60?"), null);
  assert.equal(parseDefaultRateTextCommand("0.60"), null);
  assert.equal(parseDefaultRateTextCommand("今天跑了 0.60 公里"), null);
});

test("rate formatting keeps useful precision without trailing zeroes", () => {
  assert.equal(formatDefaultElectricityRate(0.6), "0.6");
  assert.equal(formatDefaultElectricityRate(1.2345), "1.2345");
});
