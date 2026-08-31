import {
  allocateDriveEnergy,
  deriveReceiptPriceBatches,
  summarizeAllocatedCost
} from "./electricity-accounting.mjs";
import { getElectricityAccountingData } from "./store.mjs";
import { getDriveEnergyTimeline, getTeslaMateCarCount } from "./teslamate.mjs";

export async function getElectricityCostSummary(driveIds, dependencies = {}) {
  const ops = {
    getElectricityAccountingData,
    getDriveEnergyTimeline,
    getTeslaMateCarCount,
    ...dependencies
  };
  const accounting = await ops.getElectricityAccountingData();
  const batches = deriveReceiptPriceBatches(accounting.confirmed_receipts);
  const [timeline, carCount] = await Promise.all([
    ops.getDriveEnergyTimeline({
      since: batches[0]?.available_at ?? null,
      driveIds
    }),
    batches.length > 0 ? ops.getTeslaMateCarCount() : Promise.resolve(null)
  ]);
  const currentRate = accounting.pricing.default_rate_history.at(-1)?.price_cny_per_kwh ?? null;
  if (batches.length > 0 && carCount > 1) {
    const blocked = summarizeAllocatedCost({
      allocations: timeline.map((drive) => ({
        drive_id: String(drive.drive_id ?? drive.id),
        energy_kwh: drive.estimated_kwh,
        special_kwh: null,
        default_kwh: null,
        unpriced_kwh: null,
        cost_cny: null,
        allocation_reliable: false,
        cost_complete: false,
        slices: []
      })),
      driveIds
    });
    return {
      ...blocked,
      current_default_rate_cny_per_kwh: currentRate,
      special_batch_count: batches.length,
      remaining_special_kwh: null,
      unsupported_multi_car: true
    };
  }
  const replay = allocateDriveEnergy({
    drives: timeline,
    batches,
    defaultRateHistory: accounting.pricing.default_rate_history
  });
  const summary = summarizeAllocatedCost({ allocations: replay.allocations, driveIds });
  return {
    ...summary,
    current_default_rate_cny_per_kwh: currentRate,
    special_batch_count: batches.length,
    remaining_special_kwh: replay.remaining_batches.every((batch) => batch.remaining_kwh !== null)
      ? Number(replay.remaining_batches.reduce((total, batch) => total + batch.remaining_kwh, 0).toFixed(3))
      : null,
    unsupported_multi_car: false
  };
}
