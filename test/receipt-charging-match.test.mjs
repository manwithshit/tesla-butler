import test from "node:test";
import assert from "node:assert/strict";
import { matchReceiptToChargingProcesses } from "../src/receipt-charging-match.mjs";

function process(id, endAt, energy = 20) {
  return {
    id,
    start_at: "2026-08-29T06:00:00",
    end_at: endAt,
    charge_energy_added: energy,
    start_battery_level: 40,
    end_battery_level: 80
  };
}

test("an explicit receipt datetime preselects one matching charging process", () => {
  const result = matchReceiptToChargingProcesses({
    charged_at: "2026-08-29 15:48",
    energy_kwh: 20.5
  }, [
    process(10, "2026-08-29T07:47:00", 20),
    process(11, "2026-08-29T12:00:00", 8)
  ], new Date("2026-08-30T01:00:00Z"));

  assert.equal(result.status, "matched");
  assert.equal(result.selected_process_id, "10");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.accounting_at, "2026-08-29 15:48");
  assert.equal(result.accounting_at_source, "explicit_receipt");
});

test("a time-only receipt uploaded the next day can match yesterday's session", () => {
  const result = matchReceiptToChargingProcesses({
    charged_at: "15:48",
    energy_kwh: 20.5
  }, [
    process(10, "2026-08-29T07:47:00", 20),
    process(11, "2026-08-29T13:00:00", 8)
  ], new Date("2026-08-30T01:00:00Z"));

  assert.equal(result.status, "matched");
  assert.equal(result.selected_process_id, "10");
  assert.equal(result.accounting_at, "2026-08-29 15:47");
  assert.equal(result.accounting_at_source, "matched_session");
});

test("two similarly plausible sessions require user confirmation", () => {
  const result = matchReceiptToChargingProcesses({
    charged_at: "15:48",
    energy_kwh: 20
  }, [
    process(10, "2026-08-29T07:47:00", 20),
    process(11, "2026-08-28T07:50:00", 20.5)
  ], new Date("2026-08-30T01:00:00Z"));

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.selected_process_id, null);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.accounting_at, null);
});

test("a receipt with no plausible completed session remains unlinked", () => {
  const result = matchReceiptToChargingProcesses({ charged_at: "15:48", energy_kwh: 20 }, [],
    new Date("2026-08-30T01:00:00Z"));

  assert.deepEqual(result, {
    status: "unlinked",
    selected_process_id: null,
    confidence: null,
    candidates: [],
    accounting_at: null,
    accounting_at_source: null
  });
});

test("a large energy mismatch is not silently auto-linked", () => {
  const result = matchReceiptToChargingProcesses({
    charged_at: "2026-08-29 15:48",
    energy_kwh: 40
  }, [process(10, "2026-08-29T07:47:00", 5)], new Date("2026-08-30T01:00:00Z"));

  assert.notEqual(result.status, "matched");
  assert.equal(result.selected_process_id, null);
});
