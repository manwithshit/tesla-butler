import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateDriveEnergy,
  deriveReceiptPriceBatches,
  summarizeAllocatedCost
} from "../src/electricity-accounting.mjs";

function matchedReceipt(overrides = {}) {
  return {
    id: "receipt-1",
    status: "confirmed",
    created_at: "2026-08-01T01:00:00.000Z",
    updated_at: "2026-08-01T01:01:00.000Z",
    fields: { amount_cny: 15, energy_kwh: 10 },
    charging_match: {
      status: "matched",
      selected_process_id: "charge-1",
      candidates: [{
        process_id: "charge-1",
        end_at: "2026-08-01T00:00:00.000Z"
      }]
    },
    ...overrides
  };
}

function drive(id, startAt, energyKwh) {
  return { id, start_at: startAt, estimated_kwh: energyKwh };
}

test("a 10 kWh receipt batch is consumed across 3, 5 and 4 kWh drives before default price", () => {
  const batches = deriveReceiptPriceBatches([matchedReceipt()]);
  const result = allocateDriveEnergy({
    drives: [
      drive("d1", "2026-08-01T02:00:00.000Z", 3),
      drive("d2", "2026-08-01T03:00:00.000Z", 5),
      drive("d3", "2026-08-01T04:00:00.000Z", 4)
    ],
    batches,
    defaultRateHistory: [{
      effective_at: "2026-01-01T00:00:00.000Z",
      unit_price_cny_per_kwh: 0.6
    }]
  });

  assert.deepEqual(
    result.allocations.map((item) => ({
      drive_id: item.drive_id,
      special_kwh: item.special_kwh,
      default_kwh: item.default_kwh,
      cost_cny: item.cost_cny
    })),
    [
      { drive_id: "d1", special_kwh: 3, default_kwh: 0, cost_cny: 4.5 },
      { drive_id: "d2", special_kwh: 5, default_kwh: 0, cost_cny: 7.5 },
      { drive_id: "d3", special_kwh: 2, default_kwh: 2, cost_cny: 4.2 }
    ]
  );
  assert.deepEqual(result.remaining_batches, [{ batch_id: "receipt-1", remaining_kwh: 0 }]);
  assert.deepEqual(summarizeAllocatedCost({
    allocations: result.allocations,
    driveIds: ["d1", "d2", "d3"]
  }), {
    drive_count: 3,
    energy_kwh: 12,
    special_kwh: 10,
    default_kwh: 2,
    unpriced_kwh: 0,
    default_rates_cny_per_kwh: [0.6],
    cost_cny: 16.2,
    allocation_reliable: true,
    cost_complete: true,
    requested_complete: true
  });
});

test("only a valid confirmed matched receipt becomes one deterministic batch per charging process", () => {
  const first = matchedReceipt({
    id: "first-confirmed",
    created_at: "2026-08-03T01:00:00.000Z",
    updated_at: "2026-08-03T01:01:00.000Z",
    fields: { amount_cny: 0, energy_kwh: 8 },
    charging_match: {
      status: "matched",
      selected_process_id: "shared-charge",
      candidates: [{ process_id: "shared-charge", end_at: "2026-08-03T00:00:00.000Z" }]
    }
  });
  const laterDuplicateWithEarlierCandidateTime = matchedReceipt({
    id: "later-confirmed",
    created_at: "2026-08-03T02:00:00.000Z",
    updated_at: "2026-08-03T02:01:00.000Z",
    fields: { amount_cny: 16, energy_kwh: 8 },
    charging_match: {
      status: "matched",
      selected_process_id: "shared-charge",
      candidates: [{ process_id: "shared-charge", end_at: "2026-08-02T23:59:00.000Z" }]
    }
  });
  const invalid = [
    matchedReceipt({ id: "pending", status: "pending" }),
    matchedReceipt({ id: "ignored", status: "ignored" }),
    matchedReceipt({ id: "unlinked", charging_match: { status: "unlinked", selected_process_id: null, candidates: [] } }),
    matchedReceipt({ id: "no-selected-end", charging_match: { status: "matched", selected_process_id: "x", candidates: [{ process_id: "x" }] } }),
    matchedReceipt({ id: "negative-amount", fields: { amount_cny: -1, energy_kwh: 8 } }),
    matchedReceipt({ id: "zero-energy", fields: { amount_cny: 8, energy_kwh: 0 } })
  ];

  const batches = deriveReceiptPriceBatches([
    laterDuplicateWithEarlierCandidateTime,
    ...invalid,
    first
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].batch_id, "first-confirmed");
  assert.equal(batches[0].energy_kwh, 8);
  assert.equal(batches[0].unit_price_cny_per_kwh, 0);
});

test("multiple batches are available by charging end time and consumed FIFO", () => {
  const older = matchedReceipt({
    id: "older",
    fields: { amount_cny: 8, energy_kwh: 4 },
    charging_match: {
      status: "matched",
      selected_process_id: "charge-old",
      candidates: [{ process_id: "charge-old", end_at: "2026-08-01T00:00:00.000Z" }]
    }
  });
  const newer = matchedReceipt({
    id: "newer",
    fields: { amount_cny: 1, energy_kwh: 2 },
    charging_match: {
      status: "matched",
      selected_process_id: "charge-new",
      candidates: [{ process_id: "charge-new", end_at: "2026-08-01T03:00:00.000Z" }]
    }
  });
  const result = allocateDriveEnergy({
    drives: [
      drive("after-both", "2026-08-01T04:00:00.000Z", 4),
      drive("before-second", "2026-08-01T02:00:00.000Z", 3)
    ],
    batches: deriveReceiptPriceBatches([newer, older]),
    defaultRateHistory: [{ effective_at: "2026-01-01T00:00:00.000Z", unit_price_cny_per_kwh: 1 }]
  });

  assert.deepEqual(result.allocations.map((item) => item.drive_id), ["before-second", "after-both"]);
  assert.deepEqual(result.allocations[0].slices.map((slice) => slice.batch_id), ["older"]);
  assert.deepEqual(result.allocations[1].slices, [
    { source: "receipt", batch_id: "older", energy_kwh: 1, unit_price_cny_per_kwh: 2, cost_cny: 2 },
    { source: "receipt", batch_id: "newer", energy_kwh: 2, unit_price_cny_per_kwh: 0.5, cost_cny: 1 },
    { source: "default", energy_kwh: 1, unit_price_cny_per_kwh: 1, cost_cny: 1 }
  ]);
  assert.equal(result.allocations[1].cost_cny, 4);
});

test("missing drive energy does not invent a cost and makes later batch allocation unreliable", () => {
  const result = allocateDriveEnergy({
    drives: [
      drive("unknown", "2026-08-01T02:00:00.000Z", null),
      drive("later", "2026-08-01T03:00:00.000Z", 2)
    ],
    batches: deriveReceiptPriceBatches([matchedReceipt({
      fields: { amount_cny: 10, energy_kwh: 5 }
    })]),
    defaultRateHistory: [{ effective_at: "2026-01-01T00:00:00.000Z", unit_price_cny_per_kwh: 0.6 }]
  });

  assert.equal(result.allocations[0].cost_cny, null);
  assert.equal(result.allocations[0].allocation_reliable, false);
  assert.equal(result.allocations[1].energy_kwh, 2);
  assert.equal(result.allocations[1].special_kwh, null);
  assert.equal(result.allocations[1].cost_cny, null);
  assert.equal(result.allocations[1].allocation_reliable, false);
  assert.deepEqual(result.remaining_batches, [{ batch_id: "receipt-1", remaining_kwh: null }]);

  const summary = summarizeAllocatedCost({ allocations: result.allocations, driveIds: ["unknown", "later"] });
  assert.equal(summary.energy_kwh, null);
  assert.equal(summary.cost_cny, null);
  assert.equal(summary.allocation_reliable, false);
});

test("known consumption can exhaust the uncertain batch upper bound and restore later default pricing", () => {
  const result = allocateDriveEnergy({
    drives: [
      drive("unknown", "2026-08-01T02:00:00.000Z", null),
      drive("clears-upper-bound", "2026-08-01T03:00:00.000Z", 6),
      drive("reliable-again", "2026-08-01T04:00:00.000Z", 2)
    ],
    batches: deriveReceiptPriceBatches([matchedReceipt({
      fields: { amount_cny: 10, energy_kwh: 5 }
    })]),
    defaultRateHistory: [{ effective_at: "2026-01-01T00:00:00.000Z", price_cny_per_kwh: 0.6 }]
  });

  assert.equal(result.allocations[0].allocation_reliable, false);
  assert.equal(result.allocations[1].allocation_reliable, false);
  assert.equal(result.allocations[1].cost_cny, null);
  assert.equal(result.allocations[2].allocation_reliable, true);
  assert.equal(result.allocations[2].special_kwh, 0);
  assert.equal(result.allocations[2].default_kwh, 2);
  assert.equal(result.allocations[2].cost_cny, 1.2);
  assert.deepEqual(result.remaining_batches, [{ batch_id: "receipt-1", remaining_kwh: 0 }]);
});

test("missing energy before a receipt batch exists does not contaminate later FIFO balance", () => {
  const result = allocateDriveEnergy({
    drives: [
      drive("unknown-before-charge", "2026-07-31T23:00:00.000Z", null),
      drive("after-charge", "2026-08-01T02:00:00.000Z", 2)
    ],
    batches: deriveReceiptPriceBatches([matchedReceipt()]),
    defaultRateHistory: []
  });

  assert.equal(result.allocations[0].allocation_reliable, false);
  assert.equal(result.allocations[1].allocation_reliable, true);
  assert.equal(result.allocations[1].cost_cny, 3);
  assert.deepEqual(result.remaining_batches, [{ batch_id: "receipt-1", remaining_kwh: 8 }]);
});

test("default rate history uses the latest rate effective at each drive start", () => {
  const result = allocateDriveEnergy({
    drives: [
      { drive_id: "before-default", start_at: "2026-07-31T23:00:00.000Z", estimated_kwh: 1 },
      { drive_id: "old-rate", start_at: "2026-08-01T01:00:00.000Z", estimated_kwh: 2 },
      { drive_id: "new-rate", start_at: "2026-08-02T01:00:00.000Z", estimated_kwh: 2 }
    ],
    batches: [],
    defaultRateHistory: [
      { effective_at: "2026-08-02T00:00:00.000Z", price_cny_per_kwh: 0.8 },
      { effective_at: "2026-08-01T00:00:00.000Z", price_cny_per_kwh: 0.6 },
      { effective_at: "2026-07-01T00:00:00.000Z", price_cny_per_kwh: -1 }
    ]
  });

  assert.deepEqual(result.allocations.map((item) => [item.drive_id, item.cost_cny]), [
    ["before-default", null],
    ["old-rate", 1.2],
    ["new-rate", 1.6]
  ]);
  assert.deepEqual(
    result.allocations.slice(1).map((item) => item.slices[0].unit_price_cny_per_kwh),
    [0.6, 0.8]
  );
  assert.deepEqual(
    summarizeAllocatedCost({ allocations: result.allocations, driveIds: ["old-rate", "new-rate"] })
      .default_rates_cny_per_kwh,
    [0.6, 0.8]
  );
  assert.deepEqual(
    summarizeAllocatedCost({ allocations: result.allocations, driveIds: ["old-rate"] })
      .default_rates_cny_per_kwh,
    [0.6]
  );
});

test("a pure receipt-price allocation reports no default rate as used", () => {
  const replay = allocateDriveEnergy({
    drives: [drive("receipt-only", "2026-08-01T02:00:00.000Z", 2)],
    batches: deriveReceiptPriceBatches([matchedReceipt()]),
    defaultRateHistory: [{ effective_at: "2026-01-01T00:00:00.000Z", price_cny_per_kwh: 0.6 }]
  });

  const summary = summarizeAllocatedCost({ allocations: replay.allocations });
  assert.equal(summary.special_kwh, 2);
  assert.equal(summary.default_kwh, 0);
  assert.deepEqual(summary.default_rates_cny_per_kwh, []);
});

test("a late-confirmed receipt is replayed from its matched charging end time", () => {
  const late = matchedReceipt({
    id: "late",
    created_at: "2026-08-05T10:00:00.000Z",
    updated_at: "2026-08-05T10:01:00.000Z",
    fields: { amount_cny: 12, energy_kwh: 6 },
    charging_match: {
      status: "matched",
      selected_process_id: "earlier-charge",
      candidates: [{ process_id: "earlier-charge", end_at: "2026-08-01T00:00:00.000Z" }]
    }
  });
  const batches = deriveReceiptPriceBatches({ late });
  const result = allocateDriveEnergy({
    drives: [drive("between-charge-and-upload", "2026-08-02T00:00:00.000Z", 4)],
    batches,
    defaultRateHistory: [{ effective_at: "2026-01-01T00:00:00.000Z", price_cny_per_kwh: 0.5 }]
  });

  assert.equal(batches[0].available_at, "2026-08-01T00:00:00.000Z");
  assert.equal(result.allocations[0].special_kwh, 4);
  assert.equal(result.allocations[0].cost_cny, 8);
  assert.equal(result.remaining_batches[0].remaining_kwh, 2);
});

test("high, low and free receipt prices remain direct non-negative FIFO costs", () => {
  const receipts = [
    { id: "high", process: "c1", end: "2026-08-01T00:00:00.000Z", amount: 6, energy: 2 },
    { id: "low", process: "c2", end: "2026-08-01T01:00:00.000Z", amount: 1, energy: 2 },
    { id: "free", process: "c3", end: "2026-08-01T02:00:00.000Z", amount: 0, energy: 2 }
  ].map((item, index) => matchedReceipt({
    id: item.id,
    created_at: `2026-08-01T0${index + 3}:00:00.000Z`,
    updated_at: `2026-08-01T0${index + 3}:01:00.000Z`,
    fields: { amount_cny: item.amount, energy_kwh: item.energy },
    charging_match: {
      status: "matched",
      selected_process_id: item.process,
      candidates: [{ process_id: item.process, end_at: item.end }]
    }
  }));
  const result = allocateDriveEnergy({
    drives: [drive("priced", "2026-08-01T04:00:00.000Z", 6)],
    batches: deriveReceiptPriceBatches(receipts),
    defaultRateHistory: []
  });

  assert.deepEqual(result.allocations[0].slices.map((slice) => slice.unit_price_cny_per_kwh), [3, 0.5, 0]);
  assert.equal(result.allocations[0].cost_cny, 7);
  assert.ok(result.allocations[0].cost_cny >= 0);
});

test("known energy beyond available batches stays unpriced when no default exists", () => {
  const result = allocateDriveEnergy({
    drives: [drive("partly-covered", "2026-08-01T02:00:00.000Z", 2)],
    batches: deriveReceiptPriceBatches([matchedReceipt({ fields: { amount_cny: 1, energy_kwh: 1 } })]),
    defaultRateHistory: []
  });

  assert.deepEqual({
    special_kwh: result.allocations[0].special_kwh,
    default_kwh: result.allocations[0].default_kwh,
    unpriced_kwh: result.allocations[0].unpriced_kwh,
    cost_cny: result.allocations[0].cost_cny,
    allocation_reliable: result.allocations[0].allocation_reliable,
    cost_complete: result.allocations[0].cost_complete
  }, {
    special_kwh: 1,
    default_kwh: 0,
    unpriced_kwh: 1,
    cost_cny: null,
    allocation_reliable: true,
    cost_complete: false
  });
});

test("empty input produces a complete zero summary", () => {
  const result = allocateDriveEnergy({ drives: [], batches: [], defaultRateHistory: [] });
  assert.deepEqual(result, { allocations: [], remaining_batches: [] });
  assert.deepEqual(summarizeAllocatedCost({ allocations: [] }), {
    drive_count: 0,
    energy_kwh: 0,
    special_kwh: 0,
    default_kwh: 0,
    unpriced_kwh: 0,
    default_rates_cny_per_kwh: [],
    cost_cny: 0,
    allocation_reliable: true,
    cost_complete: true,
    requested_complete: true
  });
});

test("a requested drive missing from the timeline is never reported as a zero-cost success", () => {
  const summary = summarizeAllocatedCost({ allocations: [], driveIds: ["missing"] });
  assert.equal(summary.drive_count, 0);
  assert.equal(summary.cost_cny, null);
  assert.equal(summary.allocation_reliable, false);
  assert.equal(summary.cost_complete, false);
  assert.equal(summary.requested_complete, false);
});

test("period totals retain precise batch cost until final currency rounding", () => {
  const batches = deriveReceiptPriceBatches([matchedReceipt({
    fields: { amount_cny: 1, energy_kwh: 3 }
  })]);
  const replay = allocateDriveEnergy({
    drives: [
      drive("d1", "2026-08-01T01:00:00.000Z", 1),
      drive("d2", "2026-08-01T02:00:00.000Z", 1),
      drive("d3", "2026-08-01T03:00:00.000Z", 1)
    ],
    batches,
    defaultRateHistory: []
  });
  assert.deepEqual(replay.allocations.map((item) => item.cost_cny), [0.33, 0.33, 0.33]);
  assert.equal(summarizeAllocatedCost({ allocations: replay.allocations }).cost_cny, 1);
});
