import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChargingReceipt,
  parseVisionReceipt,
  validateReceipt
} from "../src/receipt-recognizer.mjs";

const observations = [
  { text: "原始电费", confidence: 0.99, x: 0.08, y: 0.45, width: 0.15, height: 0.03 },
  { text: "¥13.36", confidence: 0.99, x: 0.80, y: 0.45, width: 0.12, height: 0.03 },
  { text: "原始服务费", confidence: 0.99, x: 0.08, y: 0.41, width: 0.20, height: 0.03 },
  { text: "¥8.49", confidence: 0.99, x: 0.82, y: 0.41, width: 0.10, height: 0.03 },
  { text: "实付款¥21.85", confidence: 0.99, x: 0.66, y: 0.34, width: 0.25, height: 0.03 },
  { text: "19:18~19:29", confidence: 0.98, x: 0.06, y: 0.20, width: 0.25, height: 0.03 },
  { text: "¥1.39/度", confidence: 0.99, x: 0.06, y: 0.15, width: 0.18, height: 0.03 },
  { text: "电费:¥0.85 | 服务费:¥0.54", confidence: 0.98, x: 0.52, y: 0.15, width: 0.40, height: 0.03 }
];

test("Vision observations deterministically parse the real receipt layout", () => {
  const receipt = parseVisionReceipt(observations);
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
    confidence: 1,
    recognition_source: "apple_vision"
  });
  assert.equal(validateReceipt(receipt), null);
});

test("Vision parser handles labels and values split into separate boxes", () => {
  const split = [
    { text: "实付金额", confidence: 1, x: 0.1, y: 0.6, width: 0.15, height: 0.03 },
    { text: "¥20.00", confidence: 1, x: 0.75, y: 0.6, width: 0.15, height: 0.03 },
    { text: "充电电量", confidence: 1, x: 0.1, y: 0.5, width: 0.15, height: 0.03 },
    { text: "10.00 kWh", confidence: 1, x: 0.75, y: 0.5, width: 0.15, height: 0.03 }
  ];
  const receipt = parseVisionReceipt(split);
  assert.equal(receipt.amount_cny, 20);
  assert.equal(receipt.energy_kwh, 10);
  assert.equal(validateReceipt(receipt), null);
});

test("Vision parser preserves an explicit receipt date with the charging end time", () => {
  const receipt = parseVisionReceipt([
    ...observations,
    { text: "充电日期 2026-08-29", confidence: 0.99, x: 0.06, y: 0.25, width: 0.25, height: 0.03 }
  ]);

  assert.equal(receipt.charged_at, "2026-08-29 19:29");
});

test("Apple Vision succeeds without invoking K3", async () => {
  let fallbackCalls = 0;
  const receipt = await analyzeChargingReceipt("/tmp/receipt.png", {
    recognizeText: async () => observations,
    analyzeWithK3: async () => {
      fallbackCalls += 1;
      return {};
    },
    k3FallbackEnabled: true
  });
  assert.equal(receipt.recognition_source, "apple_vision");
  assert.equal(fallbackCalls, 0);
});

test("incomplete Vision output falls back to K3", async () => {
  let fallbackCalls = 0;
  const receipt = await analyzeChargingReceipt("/tmp/receipt.png", {
    recognizeText: async () => [{ text: "充电完成", confidence: 0.99, x: 0, y: 0, width: 1, height: 0.1 }],
    analyzeWithK3: async () => {
      fallbackCalls += 1;
      return { amount_cny: 20, energy_kwh: 10, confidence: 0.8 };
    },
    k3FallbackEnabled: true
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(receipt.recognition_source, "k3_fallback");
});

test("Vision failure is explicit when K3 is not configured", async () => {
  await assert.rejects(
    analyzeChargingReceipt("/tmp/receipt.png", {
      recognizeText: async () => [],
      k3FallbackEnabled: false
    }),
    (error) => error.code === "RECEIPT_RECOGNITION_INCOMPLETE"
  );
});

test("K3 failure preserves an explicit combined recognition error", async () => {
  await assert.rejects(
    analyzeChargingReceipt("/tmp/receipt.png", {
      recognizeText: async () => [],
      analyzeWithK3: async () => {
        const error = new Error("offline");
        error.code = "KIMI_NETWORK";
        throw error;
      },
      k3FallbackEnabled: true
    }),
    (error) => error.code === "RECEIPT_RECOGNITION_FAILED" && error.visionCode === "VISION_INCOMPLETE" && error.k3Code === "KIMI_NETWORK"
  );
});
