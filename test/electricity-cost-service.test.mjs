import test from "node:test";
import assert from "node:assert/strict";
import { getElectricityCostSummary } from "../src/electricity-cost-service.mjs";

test("cost service replays confirmed matched batches and returns only selected drive totals", async () => {
  let timelineQuery;
  const result = await getElectricityCostSummary(["drive-2"], {
    getElectricityAccountingData: async () => ({
      pricing: {
        default_rate_history: [{
          price_cny_per_kwh: 0.6,
          effective_at: "1970-01-01T00:00:00.000Z"
        }]
      },
      confirmed_receipts: [{
        id: "receipt",
        status: "confirmed",
        created_at: "2026-08-01T00:01:00.000Z",
        fields: { amount_cny: 10, energy_kwh: 10 },
        charging_match: {
          status: "matched",
          selected_process_id: "charge",
          candidates: [{ process_id: "charge", end_at: "2026-08-01T00:00:00.000Z" }]
        }
      }]
    }),
    getTeslaMateCarCount: async () => 1,
    getDriveEnergyTimeline: async (query) => {
      timelineQuery = query;
      return [
      { drive_id: "drive-1", start_at: "2026-08-01T01:00:00.000Z", estimated_kwh: 4 },
      { drive_id: "drive-2", start_at: "2026-08-01T02:00:00.000Z", estimated_kwh: 8 }
      ];
    }
  });

  assert.equal(result.drive_count, 1);
  assert.equal(result.special_kwh, 6);
  assert.equal(result.default_kwh, 2);
  assert.equal(result.cost_cny, 7.2);
  assert.deepEqual(result.default_rates_cny_per_kwh, [0.6]);
  assert.equal(result.current_default_rate_cny_per_kwh, 0.6);
  assert.equal(result.remaining_special_kwh, 0);
  assert.deepEqual(timelineQuery, {
    since: "2026-08-01T00:00:00.000Z",
    driveIds: ["drive-2"]
  });
});

test("cost service leaves a trip unpriced when no reliable rate covers all energy", async () => {
  const result = await getElectricityCostSummary(["drive"], {
    getElectricityAccountingData: async () => ({
      pricing: { default_rate_history: [] },
      confirmed_receipts: []
    }),
    getDriveEnergyTimeline: async () => [
      { drive_id: "drive", start_at: "2026-08-01T02:00:00.000Z", estimated_kwh: 2 }
    ]
  });

  assert.equal(result.cost_cny, null);
  assert.equal(result.unpriced_kwh, 2);
  assert.equal(result.current_default_rate_cny_per_kwh, null);
});

test("cost service distinguishes the historical rate actually used from the current setting", async () => {
  const result = await getElectricityCostSummary(["old-drive"], {
    getElectricityAccountingData: async () => ({
      pricing: {
        default_rate_history: [
          { price_cny_per_kwh: 0.6, effective_at: "2026-01-01T00:00:00.000Z" },
          { price_cny_per_kwh: 0.9, effective_at: "2026-08-02T00:00:00.000Z" }
        ]
      },
      confirmed_receipts: []
    }),
    getDriveEnergyTimeline: async () => [
      { drive_id: "old-drive", start_at: "2026-08-01T02:00:00.000Z", estimated_kwh: 2 }
    ]
  });

  assert.equal(result.cost_cny, 1.2);
  assert.deepEqual(result.default_rates_cny_per_kwh, [0.6]);
  assert.equal(result.current_default_rate_cny_per_kwh, 0.9);
});

test("cost service fails closed instead of sharing a special-price batch across cars", async () => {
  const result = await getElectricityCostSummary(["drive-a"], {
    getElectricityAccountingData: async () => ({
      pricing: {
        default_rate_history: [{
          price_cny_per_kwh: 0.6,
          effective_at: "1970-01-01T00:00:00.000Z"
        }]
      },
      confirmed_receipts: [{
        id: "receipt",
        status: "confirmed",
        fields: { amount_cny: 10, energy_kwh: 10 },
        charging_match: {
          status: "matched",
          selected_process_id: "charge",
          candidates: [{ process_id: "charge", end_at: "2026-08-01T00:00:00.000Z" }]
        }
      }]
    }),
    getTeslaMateCarCount: async () => 2,
    getDriveEnergyTimeline: async () => [
      { drive_id: "drive-a", car_id: "car-a", start_at: "2026-08-01T01:00:00.000Z", estimated_kwh: 2 }
    ]
  });

  assert.equal(result.unsupported_multi_car, true);
  assert.equal(result.cost_cny, null);
  assert.equal(result.allocation_reliable, false);
  assert.equal(result.requested_complete, true);
});
