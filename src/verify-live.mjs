import { assertCard, buildPeriodReportCard } from "./cards.mjs";
import { calculateFuelComparisons } from "./comparisons.mjs";
import { getElectricityCostSummary } from "./electricity-cost-service.mjs";
import { getReceiptTotals } from "./store.mjs";
import { getLatestTrip, getPeriodTrips } from "./teslamate.mjs";

const [latest, trips, receipts] = await Promise.all([
  getLatestTrip(),
  getPeriodTrips("week"),
  getReceiptTotals("week")
]);

if (!latest || latest.energy_source !== "power_integration" || !(latest.estimated_kwh > 0)) {
  throw new Error("latest trip power integration is unavailable");
}
if (!(trips.trip_count > 0) || trips.energy_source !== "power_integration" || !(trips.estimated_kwh > 0)) {
  throw new Error("period trip power integration is unavailable");
}
const allocatedFees = receipts.electricity_fee_cny + receipts.service_fee_cny;
if (receipts.count > 0 && allocatedFees - receipts.amount_cny > 0.05) {
  throw new Error("known receipt fee breakdown exceeds total paid");
}

const pricingSummary = await getElectricityCostSummary(trips.drive_ids || []);
const tripElectricCost = pricingSummary.cost_cny;
const comparisons = calculateFuelComparisons(trips.distance_km, tripElectricCost);
const card = assertCard(buildPeriodReportCard({
  period: "week", trips, receipts, comparisons, tripElectricCost, pricingSummary
}));
if (tripElectricCost !== null && comparisons.items.some((item) => item.saving_cny === null)) {
  throw new Error("fuel comparison is incomplete");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  latest_trip_energy_ready: latest.energy_source === "power_integration" && latest.estimated_kwh > 0,
  week: {
    trip_count: trips.trip_count,
    energy_ready: trips.energy_source === "power_integration" && trips.estimated_kwh > 0,
    cost_available: tripElectricCost !== null
  },
  receipt: {
    count: receipts.count,
    fee_breakdown_valid: allocatedFees - receipts.amount_cny <= 0.05
  },
  default_rate_set: pricingSummary.current_default_rate_cny_per_kwh !== null,
  card_blocks: card.body.elements.length
}, null, 2)}\n`);
