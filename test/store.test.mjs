import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConfirmedReceiptEnrichment,
  applyDefaultElectricityRate,
  applyDefaultRatePrompted,
  applyReceiptStatus,
  applyReceiptChargingMatch,
  ensureReceiptAccounting,
  getElectricityAccountingData,
  getPricingSettings,
  getReceiptTotals,
  savePendingReceipt,
  setDefaultElectricityRate,
  mergeReceiptEnrichment,
  normalizeReceiptFields,
  selectReceiptChargingCandidate,
  setReceiptStatus
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

test("the first default electricity rate backfills history from the epoch and preserves root metadata", () => {
  const store = { receipts: {}, migration_marker: { preserved: true } };
  const result = applyDefaultElectricityRate(store, "0.6388", {
    now: new Date("2026-08-31T01:00:00.000Z"),
    source: "user_manual"
  });

  assert.equal(result.changed, true);
  assert.deepEqual(store.migration_marker, { preserved: true });
  assert.deepEqual(store.pricing, {
    schema_version: 1,
    default_rate_history: [{
      price_cny_per_kwh: 0.6388,
      effective_at: "1970-01-01T00:00:00.000Z",
      recorded_at: "2026-08-31T01:00:00.000Z",
      source: "user_manual"
    }]
  });
});

test("later default-rate changes start now while an identical submission is idempotent", () => {
  const store = { receipts: {} };
  applyDefaultElectricityRate(store, 0.6, {
    now: new Date("2026-08-31T01:00:00.000Z"), source: "user_manual"
  });
  const changed = applyDefaultElectricityRate(store, 0.8, {
    now: new Date("2026-09-01T01:00:00.000Z"), source: "user_manual"
  });
  const repeated = applyDefaultElectricityRate(store, "0.8000", {
    now: new Date("2026-09-02T01:00:00.000Z"), source: "quick_pick"
  });

  assert.equal(changed.changed, true);
  assert.equal(repeated.changed, false);
  assert.equal(store.pricing.default_rate_history.length, 2);
  assert.equal(store.pricing.default_rate_history[1].effective_at, "2026-09-01T01:00:00.000Z");
  assert.equal(store.pricing.default_rate_history[1].recorded_at, "2026-09-01T01:00:00.000Z");
  assert.equal(store.pricing.default_rate_history[1].source, "user_manual");
});

test("default electricity rate accepts zero through ten with four decimals and rejects invalid values", () => {
  for (const value of [0, 10, 0.1234]) {
    assert.doesNotThrow(() => applyDefaultElectricityRate({ receipts: {} }, value));
  }
  for (const value of [-0.1, 10.0001, 0.12345, "not-a-rate", Infinity]) {
    assert.throws(
      () => applyDefaultElectricityRate({ receipts: {} }, value),
      (error) => error?.code === "INVALID_ELECTRICITY_RATE"
    );
  }
});

test("pricing reads are legacy-compatible and accounting data contains confirmed receipts only", async () => {
  const legacy = {
    receipts: {
      confirmed: { id: "confirmed", status: "confirmed", fields: { amount_cny: 10 } },
      pending: { id: "pending", status: "pending", fields: { amount_cny: 20 } }
    },
    legacy_marker: true
  };

  assert.deepEqual(await getPricingSettings({ store: legacy }), {
    schema_version: 1,
    default_rate_history: []
  });
  const accounting = await getElectricityAccountingData({ store: legacy });
  assert.deepEqual(accounting.pricing.default_rate_history, []);
  assert.deepEqual(accounting.confirmed_receipts.map((receipt) => receipt.id), ["confirmed"]);
  assert.equal(legacy.legacy_marker, true);
});

test("all receipt writes share one queue so concurrent saves do not lose records or root fields", async () => {
  let backing = { receipts: {}, pricing: { schema_version: 1, default_rate_history: [] }, root_marker: "keep" };
  const io = {
    readStore: async () => structuredClone(backing),
    writeStore: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      backing = structuredClone(next);
    }
  };

  await Promise.all([
    savePendingReceipt({ messageId: "one", imagePath: "one.png", fields: {}, receivedAt: new Date(0) }, io),
    savePendingReceipt({ messageId: "two", imagePath: "two.png", fields: {}, receivedAt: new Date(1) }, io),
    setDefaultElectricityRate(0.6, { ...io, now: new Date("2026-08-31T01:00:00Z") })
  ]);

  assert.equal(Object.keys(backing.receipts).length, 2);
  assert.equal(backing.pricing.default_rate_history.length, 1);
  assert.equal(backing.root_marker, "keep");
});

for (const status of ["pending", "confirmed", "ignored"]) {
  test(`a redelivered receipt does not overwrite an existing ${status} record`, async () => {
    const messageId = `redelivered-${status}`;
    let backing = { receipts: {}, root_marker: "keep" };
    let writeCount = 0;
    const io = {
      readStore: async () => structuredClone(backing),
      writeStore: async (next) => {
        writeCount += 1;
        backing = structuredClone(next);
      }
    };

    const first = await savePendingReceipt({
      messageId,
      imagePath: "original.png",
      fields: { amount_cny: 12.34, marker: "original" },
      receivedAt: new Date("2026-08-30T01:00:00.000Z")
    }, io);
    if (status !== "pending") {
      await setReceiptStatus(first.id, status, {
        ...io,
        now: new Date("2026-08-30T02:00:00.000Z")
      });
    }
    const beforeRedelivery = structuredClone(backing);
    writeCount = 0;

    const result = await savePendingReceipt({
      messageId,
      imagePath: "redelivery.png",
      fields: { amount_cny: 99.99, marker: "redelivery" },
      chargingMatch: { status: "unlinked" },
      receivedAt: new Date("2026-08-31T01:00:00.000Z")
    }, io);

    assert.deepEqual(result, beforeRedelivery.receipts[first.id]);
    assert.deepEqual(backing, beforeRedelivery);
    assert.equal(backing.root_marker, "keep");
    assert.equal(writeCount, 0);
  });
}

test("confirming two receipts for one matched charging process is rejected with a stable code", () => {
  const store = {
    receipts: {
      first: {
        id: "first", status: "confirmed", fields: {},
        charging_match: { status: "matched", selected_process_id: "42" }
      },
      second: {
        id: "second", status: "pending", fields: {}, created_at: "2026-08-31T01:00:00Z",
        charging_match: { status: "matched", selected_process_id: 42 }
      }
    }
  };

  assert.throws(
    () => applyReceiptStatus(store, "second", "confirmed", new Date("2026-08-31T02:00:00Z")),
    (error) => error?.code === "DUPLICATE_CHARGING_PROCESS_RECEIPT"
  );
  assert.equal(store.receipts.second.status, "pending");
});

test("enriching a schema 3 receipt never downgrades it", () => {
  const store = {
    receipts: {
      example: {
        id: "example", status: "confirmed", schema_version: 3,
        created_at: "2026-08-31T01:00:00Z",
        fields: { amount_cny: 10, energy_kwh: 5 }
      }
    }
  };

  const receipt = applyConfirmedReceiptEnrichment(store, "example", { service_fee_cny: 2 });
  assert.equal(receipt.schema_version, 3);
  assert.equal(receipt.fields.service_fee_cny, 2);
});

test("marking the onboarding price prompt is idempotent and preserves runtime state", () => {
  const state = { sent: { existing: "yes" }, trip_monitor: { phase: "idle" } };
  const first = applyDefaultRatePrompted(state, new Date("2026-08-31T01:00:00Z"));
  const second = applyDefaultRatePrompted(state, new Date("2026-08-31T02:00:00Z"));

  assert.equal(first, "2026-08-31T01:00:00.000Z");
  assert.equal(second, first);
  assert.deepEqual(state.sent, { existing: "yes" });
  assert.deepEqual(state.trip_monitor, { phase: "idle" });
  assert.equal(state.onboarding.default_rate_prompted_at, first);
});
