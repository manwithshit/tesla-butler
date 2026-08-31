import { getReferenceFuelPrices } from "./fuel-prices.mjs";

export const comparisonCars = Object.freeze([
  { name: "日产轩逸", model_spec: "十五代轩逸", consumption: 5.88, grade: "92", source: "东风日产 WLTC" },
  { name: "宝马5系", model_spec: "BMW 530Li", consumption: 6.70, grade: "95", source: "BMW 中国 WLTC" },
  { name: "路虎卫士", model_spec: "卫士 110 P400", consumption: 11.27, grade: "95", source: "工信部同系记录" },
  { name: "保时捷911", model_spec: "911 GT3", consumption: 12.70, grade: "98", source: "工信部记录" },
  { name: "兰博基尼超跑", model_spec: "Aventador S Roadster（经典停产）", consumption: 19.20, grade: "98", source: "Lamborghini 历史车型页" }
]);

export function calculateTripElectricCost(energyKwh, allInUnitPrice) {
  if (energyKwh === null || energyKwh === undefined || allInUnitPrice === null || allInUnitPrice === undefined) return null;
  const energy = Number(energyKwh);
  const unitPrice = Number(allInUnitPrice);
  if (!Number.isFinite(energy) || !Number.isFinite(unitPrice) || energy < 0 || unitPrice < 0) return null;
  return Number((energy * unitPrice).toFixed(2));
}

export function calculateFuelComparisons(distanceKm, teslaCost = null, options = {}) {
  const distance = Math.max(0, Number(distanceKm) || 0);
  const actualTeslaCost = teslaCost === null ? null : Math.max(0, Number(teslaCost) || 0);
  const reference = options.reference || getReferenceFuelPrices();
  const prices = reference.prices;
  return {
    prices,
    price_basis: `统一参考油价：92# ¥${prices["92"].toFixed(2)} / 95# ¥${prices["95"].toFixed(2)} / 98# ¥${prices["98"].toFixed(2)}`,
    price_scope: reference.price_scope,
    price_source: reference.price_source,
    effective_date: reference.effective_date,
    is_current_day: reference.is_current_day,
    is_demo_price: false,
    items: comparisonCars.map((car) => {
      const liters = distance * car.consumption / 100;
      const cost = liters * prices[car.grade];
      return {
        ...car,
        liters: Number(liters.toFixed(2)),
        cost_cny: Number(cost.toFixed(2)),
        saving_cny: actualTeslaCost === null ? null : Number((cost - actualTeslaCost).toFixed(2))
      };
    })
  };
}
