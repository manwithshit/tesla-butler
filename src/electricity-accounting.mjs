function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function receiptValues(receipts) {
  if (Array.isArray(receipts)) return receipts;
  if (receipts && typeof receipts === "object") return Object.values(receipts);
  return [];
}

export function deriveReceiptPriceBatches(receipts) {
  const candidates = receiptValues(receipts).flatMap((receipt) => {
    if (receipt?.status !== "confirmed" || receipt?.charging_match?.status !== "matched") return [];
    const processId = receipt.charging_match.selected_process_id;
    if (processId === null || processId === undefined || processId === "") return [];
    const selected = (receipt.charging_match.candidates || []).find(
      (candidate) => String(candidate?.process_id) === String(processId)
    );
    const availableAtMs = timestamp(selected?.end_at);
    const amount = finiteNumber(receipt.fields?.amount_cny);
    const energy = finiteNumber(receipt.fields?.energy_kwh);
    if (availableAtMs === null || amount === null || amount < 0 || energy === null || energy <= 0) return [];
    const confirmedAt = receipt.confirmed_at || receipt.updated_at || receipt.created_at || null;
    return [{
      batch_id: String(receipt.id),
      receipt_id: String(receipt.id),
      charging_process_id: String(processId),
      available_at: selected.end_at,
      available_at_ms: availableAtMs,
      confirmed_at: confirmedAt,
      confirmed_at_ms: timestamp(confirmedAt) ?? Number.POSITIVE_INFINITY,
      energy_kwh: round(energy),
      amount_cny: round(amount, 2),
      price_cny_per_kwh: round(amount / energy, 12),
      unit_price_cny_per_kwh: round(amount / energy, 12)
    }];
  });

  candidates.sort((left, right) =>
    left.confirmed_at_ms - right.confirmed_at_ms
    || left.batch_id.localeCompare(right.batch_id)
  );
  const seenProcesses = new Set();
  return candidates.filter((batch) => {
    if (seenProcesses.has(batch.charging_process_id)) return false;
    seenProcesses.add(batch.charging_process_id);
    return true;
  }).sort((left, right) =>
    left.available_at_ms - right.available_at_ms
    || left.confirmed_at_ms - right.confirmed_at_ms
    || left.batch_id.localeCompare(right.batch_id)
  );
}

function normalizedDefaultRates(history) {
  return (Array.isArray(history) ? history : []).flatMap((rate, index) => {
    const effectiveAtMs = timestamp(rate?.effective_at);
    const unitPrice = finiteNumber(rate?.price_cny_per_kwh ?? rate?.unit_price_cny_per_kwh);
    if (effectiveAtMs === null || unitPrice === null || unitPrice < 0) return [];
    return [{ ...rate, index, effective_at_ms: effectiveAtMs, unit_price_cny_per_kwh: unitPrice }];
  }).sort((left, right) => left.effective_at_ms - right.effective_at_ms || left.index - right.index);
}

function defaultRateAt(rates, driveAtMs) {
  let result = null;
  for (const rate of rates) {
    if (rate.effective_at_ms > driveAtMs) break;
    result = rate.unit_price_cny_per_kwh;
  }
  return result;
}

export function allocateDriveEnergy({ drives = [], batches = [], defaultRateHistory = [] } = {}) {
  const rates = normalizedDefaultRates(defaultRateHistory);
  const queue = (Array.isArray(batches) ? batches : []).map((batch) => ({
    ...batch,
    available_at_ms: finiteNumber(batch.available_at_ms) ?? timestamp(batch.available_at),
    remaining_kwh: Math.max(0, finiteNumber(batch.energy_kwh) ?? 0),
    unit_price_cny_per_kwh: finiteNumber(batch.price_cny_per_kwh ?? batch.unit_price_cny_per_kwh)
  })).filter((batch) => batch.available_at_ms !== null && batch.unit_price_cny_per_kwh !== null && batch.unit_price_cny_per_kwh >= 0)
    .sort((left, right) =>
      left.available_at_ms - right.available_at_ms
      || (finiteNumber(left.confirmed_at_ms) ?? Number.POSITIVE_INFINITY)
        - (finiteNumber(right.confirmed_at_ms) ?? Number.POSITIVE_INFINITY)
      || String(left.batch_id).localeCompare(String(right.batch_id))
    );

  const orderedDrives = (Array.isArray(drives) ? drives : []).map((drive, index) => ({
    ...drive,
    index,
    drive_at_ms: timestamp(drive?.start_at)
  })).sort((left, right) => (left.drive_at_ms ?? Number.POSITIVE_INFINITY) - (right.drive_at_ms ?? Number.POSITIVE_INFINITY) || left.index - right.index);

  const allocations = [];
  let batchBalanceReliable = true;
  for (const drive of orderedDrives) {
    const energy = finiteNumber(drive.estimated_kwh);
    if (drive.drive_at_ms === null || energy === null || energy < 0) {
      const couldConsumeBatch = queue.some((batch) =>
        batch.remaining_kwh > 0
        && (drive.drive_at_ms === null || batch.available_at_ms <= drive.drive_at_ms)
      );
      if (couldConsumeBatch) batchBalanceReliable = false;
      allocations.push({
        drive_id: String(drive.id ?? drive.drive_id), start_at: drive.start_at, energy_kwh: null,
        special_kwh: 0, default_kwh: 0, unpriced_kwh: 0, cost_cny: null, cost_cny_precise: null,
        allocation_reliable: false, cost_complete: false, slices: []
      });
      continue;
    }

    if (!batchBalanceReliable) {
      let upperBoundConsumption = energy;
      for (const batch of queue) {
        if (upperBoundConsumption <= 0 || batch.available_at_ms > drive.drive_at_ms || batch.remaining_kwh <= 0) continue;
        const consumed = Math.min(upperBoundConsumption, batch.remaining_kwh);
        batch.remaining_kwh = round(batch.remaining_kwh - consumed);
        upperBoundConsumption = round(upperBoundConsumption - consumed);
      }
      const availableUpperBoundExhausted = queue.every((batch) =>
        batch.available_at_ms > drive.drive_at_ms || batch.remaining_kwh <= 0
      );
      allocations.push({
        drive_id: String(drive.id ?? drive.drive_id),
        start_at: drive.start_at,
        energy_kwh: round(energy),
        special_kwh: null,
        default_kwh: null,
        unpriced_kwh: null,
        cost_cny: null,
        cost_cny_precise: null,
        allocation_reliable: false,
        cost_complete: false,
        slices: []
      });
      if (availableUpperBoundExhausted) batchBalanceReliable = true;
      continue;
    }

    let remaining = energy;
    let specialKwh = 0;
    let defaultKwh = 0;
    let unpricedKwh = 0;
    let cost = 0;
    const slices = [];
    for (const batch of queue) {
      if (remaining <= 0 || batch.available_at_ms > drive.drive_at_ms || batch.remaining_kwh <= 0) continue;
      const consumed = Math.min(remaining, batch.remaining_kwh);
      batch.remaining_kwh = round(batch.remaining_kwh - consumed);
      remaining = round(remaining - consumed);
      specialKwh += consumed;
      cost += consumed * batch.unit_price_cny_per_kwh;
      slices.push({
        source: "receipt",
        batch_id: batch.batch_id,
        energy_kwh: round(consumed),
        unit_price_cny_per_kwh: batch.unit_price_cny_per_kwh,
        cost_cny: round(consumed * batch.unit_price_cny_per_kwh, 2)
      });
    }
    if (remaining > 0) {
      const defaultRate = defaultRateAt(rates, drive.drive_at_ms);
      if (defaultRate === null) {
        unpricedKwh = remaining;
        slices.push({ source: "unpriced", energy_kwh: round(remaining), unit_price_cny_per_kwh: null, cost_cny: null });
      } else {
        defaultKwh = remaining;
        cost += remaining * defaultRate;
        slices.push({
          source: "default",
          energy_kwh: round(remaining),
          unit_price_cny_per_kwh: defaultRate,
          cost_cny: round(remaining * defaultRate, 2)
        });
      }
    }
    allocations.push({
      drive_id: String(drive.id ?? drive.drive_id),
      start_at: drive.start_at,
      energy_kwh: round(energy),
      special_kwh: round(specialKwh),
      default_kwh: round(defaultKwh),
      unpriced_kwh: round(unpricedKwh),
      cost_cny: unpricedKwh > 0 ? null : round(cost, 2),
      cost_cny_precise: unpricedKwh > 0 ? null : round(cost, 10),
      allocation_reliable: true,
      cost_complete: unpricedKwh === 0,
      slices
    });
  }

  return {
    allocations,
    remaining_batches: queue.map((batch) => ({
      batch_id: batch.batch_id,
      remaining_kwh: batchBalanceReliable ? round(batch.remaining_kwh) : null
    }))
  };
}

export function summarizeAllocatedCost({ allocations = [], driveIds = null } = {}) {
  const selectedIds = driveIds === null || driveIds === undefined
    ? null
    : new Set((Array.isArray(driveIds) ? driveIds : [driveIds]).map(String));
  const selected = (Array.isArray(allocations) ? allocations : []).filter(
    (allocation) => !selectedIds || selectedIds.has(String(allocation.drive_id))
  );
  const requestedComplete = !selectedIds
    || (selectedIds.size === new Set(selected.map((item) => String(item.drive_id))).size
      && [...selectedIds].every((id) => selected.some((item) => String(item.drive_id) === id)));
  const allocationReliable = requestedComplete && selected.every((item) => item.allocation_reliable === true);
  const costComplete = allocationReliable && selected.every((item) => item.cost_complete === true && item.cost_cny !== null);
  const energyComplete = selected.every((item) => finiteNumber(item.energy_kwh) !== null);
  const sum = (field) => round(selected.reduce((total, item) => total + (finiteNumber(item[field]) ?? 0), 0));
  const defaultRates = [];
  const seenDefaultRates = new Set();
  for (const allocation of selected) {
    for (const slice of Array.isArray(allocation.slices) ? allocation.slices : []) {
      if (slice?.source !== "default" || !(finiteNumber(slice.energy_kwh) > 0)) continue;
      const rate = finiteNumber(slice.unit_price_cny_per_kwh);
      if (rate === null || rate < 0) continue;
      const key = String(rate);
      if (seenDefaultRates.has(key)) continue;
      seenDefaultRates.add(key);
      defaultRates.push(rate);
    }
  }
  return {
    drive_count: selected.length,
    energy_kwh: energyComplete ? sum("energy_kwh") : null,
    special_kwh: allocationReliable ? sum("special_kwh") : null,
    default_kwh: allocationReliable ? sum("default_kwh") : null,
    unpriced_kwh: allocationReliable ? sum("unpriced_kwh") : null,
    default_rates_cny_per_kwh: defaultRates,
    cost_cny: costComplete
      ? round(selected.reduce((total, item) => total + (finiteNumber(item.cost_cny_precise) ?? finiteNumber(item.cost_cny) ?? 0), 0), 2)
      : null,
    allocation_reliable: allocationReliable,
    cost_complete: costComplete,
    requested_complete: requestedComplete
  };
}
