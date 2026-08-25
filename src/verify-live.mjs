import { assertCard, buildPeriodReportCard } from "./cards.mjs";
import { calculateFuelComparisons, calculateTripElectricCost } from "./comparisons.mjs";
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
if (!(receipts.count > 0) || !(receipts.amount_cny > 0) || !(receipts.energy_kwh > 0)) {
  throw new Error("confirmed receipt is absent from this week");
}
const allocatedFees = receipts.electricity_fee_cny + receipts.service_fee_cny;
if (allocatedFees - receipts.amount_cny > 0.05) {
  throw new Error("known receipt fee breakdown exceeds total paid");
}

const tripElectricCost = calculateTripElectricCost(trips.estimated_kwh, receipts.all_in_unit_price_cny_per_kwh);
if (!(tripElectricCost >= 0)) throw new Error("trip electricity cost is unavailable");
const comparisons = calculateFuelComparisons(trips.distance_km, tripElectricCost);
const card = assertCard(buildPeriodReportCard({ period: "week", trips, receipts, comparisons, tripElectricCost }));
if (comparisons.items.some((item) => item.saving_cny === null)) throw new Error("fuel comparison is incomplete");

process.stdout.write(`${JSON.stringify({
  ok: true,
  latest_trip: {
    distance_km: latest.distance_km,
    estimated_kwh: latest.estimated_kwh,
    energy_source: latest.energy_source
  },
  week: {
    trip_count: trips.trip_count,
    distance_km: trips.distance_km,
    estimated_kwh: trips.estimated_kwh,
    drawn_kwh: trips.drawn_kwh,
    regenerated_kwh: trips.regenerated_kwh,
    trip_electric_cost_cny: tripElectricCost
  },
  receipt: {
    count: receipts.count,
    amount_cny: receipts.amount_cny,
    electricity_fee_cny: receipts.electricity_fee_cny,
    service_fee_cny: receipts.service_fee_cny,
    unallocated_fee_cny: Number(Math.max(0, receipts.amount_cny - allocatedFees).toFixed(2)),
    all_in_unit_price_cny_per_kwh: receipts.all_in_unit_price_cny_per_kwh
  },
  card_blocks: card.body.elements.length
}, null, 2)}\n`);
