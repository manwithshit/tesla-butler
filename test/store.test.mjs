import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReceiptChargingMatch,
  ensureReceiptAccounting,
  getReceiptTotals,
  mergeReceiptEnrichment,
  normalizeReceiptFields,
  selectReceiptChargingCandidate
} from "../src/store.mjs";

test("time-only charging time stays unresolved until a session is selected", () => {
  const fields = normalizeReceiptFields(
    { charged_at: "19:29", amount_cny: 21.85 },
    new Date("2026-08-24T13:00:16.963Z")
  );

  assert.equal(fields.charged_at, "19:29");
  assert.equal(fields.charged_at_source, "time_only");
  assert.equal(fields.accounting_at, undefined);
});

test("an explicit receipt datetime becomes the accounting datetime", () => {
  const fields = normalizeReceiptFields({ charged_at: "2026-08-23 19:29", amount_cny: 21.85 });

  assert.equal(fields.charged_at, "2026-08-23 19:29");
  assert.equal(fields.charged_at_source, "explicit");
  assert.equal(fields.accounting_at, "2026-08-23 19:29");
  assert.equal(fields.accounting_at_source, "explicit_receipt");
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
  assert.equal(fields.charged_at, "19:29");
  assert.equal(fields.charged_at_source, "time_only");
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

test("period totals use the matched accounting datetime instead of upload time", async () => {
  const store = {
    receipts: {
      delayed: {
        status: "confirmed",
        created_at: "2026-09-01T01:00:00.000Z",
        fields: {
          charged_at: "19:29",
          accounting_at: "2026-08-31 19:29",
          accounting_at_source: "matched_session",
          amount_cny: 20,
          energy_kwh: 10
        }
      }
    }
  };

  const previousMonth = await getReceiptTotals("previous_month", {
    store,
    now: new Date("2026-09-02T02:00:00.000Z")
  });
  const currentMonth = await getReceiptTotals("month", {
    store,
    now: new Date("2026-09-02T02:00:00.000Z")
  });

  assert.equal(previousMonth.count, 1);
  assert.equal(currentMonth.count, 0);
});

test("a matched charging session supplies accounting time without overwriting OCR time", () => {
  const receipt = {
    fields: { charged_at: "19:29", charged_at_source: "time_only", amount_cny: 20 },
    created_at: "2026-08-30T01:00:00.000Z"
  };
  applyReceiptChargingMatch(receipt, {
    status: "matched",
    selected_process_id: "10",
    confidence: 0.85,
    candidates: [{ process_id: "10", display_at: "2026-08-29 19:28", score: 0.85 }],
    accounting_at: "2026-08-29 19:28",
    accounting_at_source: "matched_session"
  });

  assert.equal(receipt.fields.charged_at, "19:29");
  assert.equal(receipt.fields.accounting_at, "2026-08-29 19:28");
  assert.equal(receipt.charging_match.selected_process_id, "10");
  assert.equal(receipt.charging_match.method, "automatic");
});

test("selecting one ambiguous candidate updates the pending receipt", () => {
  const receipt = {
    fields: { charged_at: "19:29", charged_at_source: "time_only" },
    charging_match: {
      status: "needs_confirmation",
      selected_process_id: null,
      candidates: [
        { process_id: "10", display_at: "2026-08-28 19:29", score: 0.8 },
        { process_id: "11", display_at: "2026-08-29 19:29", score: 0.79 }
      ]
    }
  };

  assert.equal(selectReceiptChargingCandidate(receipt, "11"), true);
  assert.equal(receipt.charging_match.status, "matched");
  assert.equal(receipt.charging_match.method, "user_selected");
  assert.equal(receipt.fields.accounting_at, "2026-08-29 19:29");
});

test("confirming an unlinked time-only receipt makes the received-date fallback explicit", () => {
  const receipt = {
    fields: { charged_at: "19:29", charged_at_source: "time_only" },
    created_at: "2026-08-30T01:00:00.000Z"
  };

  ensureReceiptAccounting(receipt);

  assert.equal(receipt.fields.accounting_at, "2026-08-30 19:29");
  assert.equal(receipt.fields.accounting_at_source, "received_date_fallback");
});
