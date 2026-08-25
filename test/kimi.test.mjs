import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeChargingReceipt, validateReceipt } from "../src/kimi.mjs";

async function testImage(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-ticket-kimi-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, "receipt.png");
  await fs.writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return imagePath;
}

function kimiResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

test("receipt validation accepts a normal bill", () => {
  assert.equal(validateReceipt({ amount_cny: 12.34, energy_kwh: 8 }), null);
});

test("receipt validation rejects missing amount", () => {
  assert.match(validateReceipt({ amount_cny: null, energy_kwh: 8 }), /实付金额/);
});

test("receipt recognition retries a truncated HTTP JSON response", async (t) => {
  const imagePath = await testImage(t);
  let calls = 0;
  const receipt = await analyzeChargingReceipt(imagePath, {
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('{"choices":', { status: 200 });
      return kimiResponse('{"energy_kwh":18.2,"amount_cny":26.5,"charged_at":null,"provider":"test","confidence":0.9}');
    }
  });
  assert.equal(calls, 2);
  assert.equal(receipt.amount_cny, 26.5);
});

test("receipt recognition retries invalid JSON in model content", async (t) => {
  const imagePath = await testImage(t);
  let calls = 0;
  const receipt = await analyzeChargingReceipt(imagePath, {
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return kimiResponse('{"energy_kwh":18.2');
      return kimiResponse('{"energy_kwh":18.2,"amount_cny":26.5,"charged_at":null,"provider":null,"confidence":0.8}');
    }
  });
  assert.equal(calls, 2);
  assert.equal(receipt.energy_kwh, 18.2);
});

test("receipt recognition reports the final parse error after all retries", async (t) => {
  const imagePath = await testImage(t);
  let calls = 0;
  await assert.rejects(
    analyzeChargingReceipt(imagePath, {
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    }),
    (error) => error.code === "KIMI_HTTP_JSON" && error.attempts === 3
  );
  assert.equal(calls, 3);
});

test("receipt recognition derives energy from visible all-in price and keeps fee breakdown", async (t) => {
  const imagePath = await testImage(t);
  const content = JSON.stringify({
    energy_kwh: null,
    amount_cny: 21.85,
    electricity_fee_cny: 13.36,
    service_fee_cny: 8.49,
    electricity_unit_price_cny_per_kwh: 0.85,
    service_unit_price_cny_per_kwh: 0.54,
    all_in_unit_price_cny_per_kwh: 1.39,
    charged_at: "19:29",
    provider: null,
    confidence: 0.9
  });

  const receipt = await analyzeChargingReceipt(imagePath, {
    retryDelayMs: 0,
    fetchImpl: async () => kimiResponse(content)
  });

  assert.deepEqual(receipt, {
    energy_kwh: 15.72,
    energy_source: "derived_all_in_price",
    amount_cny: 21.85,
    electricity_fee_cny: 13.36,
    service_fee_cny: 8.49,
    electricity_unit_price_cny_per_kwh: 0.85,
    service_unit_price_cny_per_kwh: 0.54,
    all_in_unit_price_cny_per_kwh: 1.39,
    charged_at: "19:29",
    provider: null,
    confidence: 0.9
  });
});
