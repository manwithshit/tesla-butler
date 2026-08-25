function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeReceiptResult(value = {}, recognitionSource = null) {
  const amount = numberOrNull(value.amount_cny);
  const electricityFee = numberOrNull(value.electricity_fee_cny);
  const serviceFee = numberOrNull(value.service_fee_cny);
  const electricityUnitPrice = numberOrNull(value.electricity_unit_price_cny_per_kwh);
  const serviceUnitPrice = numberOrNull(value.service_unit_price_cny_per_kwh);
  const explicitAllInUnitPrice = numberOrNull(value.all_in_unit_price_cny_per_kwh);
  const allInUnitPrice = explicitAllInUnitPrice
    ?? (electricityUnitPrice !== null && serviceUnitPrice !== null
      ? Number((electricityUnitPrice + serviceUnitPrice).toFixed(4))
      : null);
  const explicitEnergy = numberOrNull(value.energy_kwh);
  let energy = explicitEnergy !== null && explicitEnergy > 0 ? explicitEnergy : null;
  let energySource = energy === null ? null : "explicit";
  if (energy === null && amount !== null && amount > 0 && allInUnitPrice !== null && allInUnitPrice > 0) {
    energy = Number((amount / allInUnitPrice).toFixed(2));
    energySource = "derived_all_in_price";
  } else if (energy === null && electricityFee !== null && electricityFee > 0 && electricityUnitPrice !== null && electricityUnitPrice > 0) {
    energy = Number((electricityFee / electricityUnitPrice).toFixed(2));
    energySource = "derived_electricity_price";
  }

  const normalized = {
    energy_kwh: energy,
    energy_source: energySource,
    amount_cny: amount,
    electricity_fee_cny: electricityFee,
    service_fee_cny: serviceFee,
    electricity_unit_price_cny_per_kwh: electricityUnitPrice,
    service_unit_price_cny_per_kwh: serviceUnitPrice,
    all_in_unit_price_cny_per_kwh: allInUnitPrice,
    charged_at: typeof value.charged_at === "string" ? value.charged_at : null,
    provider: typeof value.provider === "string" ? value.provider.slice(0, 80) : null,
    confidence: numberOrNull(value.confidence) === null ? null : Math.max(0, Math.min(1, numberOrNull(value.confidence)))
  };
  if (recognitionSource) normalized.recognition_source = recognitionSource;
  return normalized;
}

export function validateReceipt(receipt) {
  if (!receipt || receipt.amount_cny === null) return "没有识别到实付金额";
  if (receipt.amount_cny < 0 || receipt.amount_cny > 10_000) return "实付金额超出合理范围";
  if (receipt.energy_kwh === null) return "没有识别到或推算出充电电量";
  if (receipt.energy_kwh <= 0 || receipt.energy_kwh > 500) return "充电电量超出合理范围";
  if (receipt.electricity_fee_cny !== null && receipt.service_fee_cny !== null) {
    const difference = Math.abs(receipt.electricity_fee_cny + receipt.service_fee_cny - receipt.amount_cny);
    if (difference > Math.max(0.1, receipt.amount_cny * 0.02)) return "费用拆分与实付金额不一致";
  }
  return null;
}
