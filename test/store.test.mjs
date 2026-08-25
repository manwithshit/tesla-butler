import test from "node:test";
import assert from "node:assert/strict";
import { getReceiptTotals, mergeReceiptEnrichment, normalizeReceiptFields } from "../src/store.mjs";

test("time-only charging time is stored with the received Shanghai date", () => {
  const fields = normalizeReceiptFields(
    { charged_at: "19:29", amount_cny: 21.85 },
    new Date("2026-08-24T13:00:16.963Z")
  );

  assert.equal(fields.charged_at, "2026-08-24 19:29");
  assert.equal(fields.charged_at_source, "inferred_received_date");
});

test("receipt enrichment preserves confirmed totals while adding fee details", () => {
  const fields = mergeReceiptEnrichment({
    amount_cny: 21.85,
    energy_kwh: 15.72,
    charged_at: "19:29",
    confidence: 0.6
  }, {
    amount_cny: 21.86,
    energy_kwh: 15.73,
    energy_source: "derived_all_in_price",
    electricity_fee_cny: 13.36,
    service_fee_cny: 8.49,
    all_in_unit_price_cny_per_kwh: 1.39,
    charged_at: "19:29",
    confidence: 0.78
  }, new Date("2026-08-24T13:00:16.963Z"));

  assert.equal(fields.amount_cny, 21.85);
  assert.equal(fields.energy_kwh, 15.72);
  assert.equal(fields.electricity_fee_cny, 13.36);
  assert.equal(fields.service_fee_cny, 8.49);
  assert.equal(fields.charged_at, "2026-08-24 19:29");
  assert.equal(fields.charged_at_source, "inferred_received_date");
  assert.equal(fields.confidence, 0.78);
});

test("a confirmed receipt with time only uses its received date in Shanghai", async () => {
  const store = {
    receipts: {
      example: {
        status: "confirmed",
        created_at: "2026-08-24T13:00:16.963Z",
        fields: {
          charged_at: "19:29",
          amount_cny: 21.85,
          energy_kwh: 15.72
        }
      }
    }
  };

  const totals = await getReceiptTotals("week", {
    store,
    now: new Date("2026-08-24T13:10:00.000Z")
  });

  assert.deepEqual(totals, {
    count: 1,
    amount_cny: 21.85,
    energy_kwh: 15.72,
    electricity_fee_cny: 0,
    service_fee_cny: 0,
    all_in_unit_price_cny_per_kwh: 1.39
  });
});

test("period totals expose electricity fee, service fee and weighted all-in price", async () => {
  const store = {
    receipts: {
      one: {
        status: "confirmed",
        created_at: "2026-08-24T13:00:16.963Z",
        fields: {
          charged_at: "2026-08-24 19:29",
          amount_cny: 21.85,
          energy_kwh: 15.72,
          electricity_fee_cny: 13.36,
          service_fee_cny: 8.49
        }
      }
    }
  };

  const totals = await getReceiptTotals("month", {
    store,
    now: new Date("2026-08-24T13:10:00.000Z")
  });

  assert.deepEqual(totals, {
    count: 1,
    amount_cny: 21.85,
    energy_kwh: 15.72,
    electricity_fee_cny: 13.36,
    service_fee_cny: 8.49,
    all_in_unit_price_cny_per_kwh: 1.39
  });
});
