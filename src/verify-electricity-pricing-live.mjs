import { allocateDriveEnergy, deriveReceiptPriceBatches } from "./electricity-accounting.mjs";
import { getElectricityAccountingData } from "./store.mjs";
import { getDriveEnergyTimeline, getTeslaMateCarCount } from "./teslamate.mjs";

const [accounting, drives, carCount] = await Promise.all([
  getElectricityAccountingData(),
  getDriveEnergyTimeline(),
  getTeslaMateCarCount()
]);
if (carCount !== 1) throw new Error("electricity pricing live verification requires one vehicle");
const latestDrive = drives.at(-1) || null;
if (latestDrive) {
  const latestStart = String(latestDrive.start_at || "");
  const explicitUtcStart = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(latestStart)
    ? latestStart
    : `${latestStart}Z`;
  const boundary = await getDriveEnergyTimeline({ since: explicitUtcStart });
  if (!boundary.some((drive) => String(drive.drive_id) === String(latestDrive.drive_id))) {
    throw new Error("UTC drive timeline boundary excluded its starting drive");
  }
}
const matchedProcessIds = accounting.confirmed_receipts.flatMap((receipt) => {
  const processId = receipt?.charging_match?.status === "matched"
    ? receipt.charging_match.selected_process_id
    : null;
  return processId === null || processId === undefined || processId === ""
    ? []
    : [String(processId)];
});
if (new Set(matchedProcessIds).size !== matchedProcessIds.length) {
  throw new Error("duplicate confirmed receipt charging match");
}
const batches = deriveReceiptPriceBatches(accounting.confirmed_receipts);

const replay = allocateDriveEnergy({
  drives,
  batches,
  defaultRateHistory: accounting.pricing.default_rate_history
});
if (replay.allocations.length !== drives.length) throw new Error("drive pricing timeline is incomplete");

const priced = replay.allocations.filter((item) => item.cost_cny !== null).length;
const unreliable = replay.allocations.filter((item) => !item.allocation_reliable).length;
process.stdout.write(`${JSON.stringify({
  ok: true,
  default_rate_set: accounting.pricing.default_rate_history.length > 0,
  special_batch_count: batches.length,
  completed_drive_count: drives.length,
  priced_drive_count: priced,
  unpriced_drive_count: drives.length - priced,
  unreliable_drive_count: unreliable,
  single_vehicle_supported: carCount === 1
})}\n`);
