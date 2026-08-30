const candidateWindowMs = 7 * 24 * 60 * 60 * 1_000;

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utcMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const result = new Date(normalized).getTime();
  return Number.isFinite(result) ? result : null;
}

function shanghaiParts(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(timestamp);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

function shanghaiLabel(value) {
  const timestamp = utcMs(value);
  const parts = timestamp === null ? null : shanghaiParts(new Date(timestamp));
  return parts
    ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    : null;
}

function receiptTime(value) {
  const raw = String(value || "").trim();
  const explicit = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (explicit) {
    const normalized = `${explicit[1]}-${explicit[2]}-${explicit[3]} ${String(explicit[4]).padStart(2, "0")}:${explicit[5]}`;
    const timestamp = new Date(`${normalized.replace(" ", "T")}:00+08:00`).getTime();
    return Number.isFinite(timestamp)
      ? { kind: "explicit", timestamp, accountingAt: normalized }
      : null;
  }
  const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { kind: "time_only", clockMinutes: hour * 60 + minute };
    }
  }
  return null;
}

function clockDistance(left, right) {
  const difference = Math.abs(left - right);
  return Math.min(difference, 24 * 60 - difference);
}

function timeScore(receipt, processEndMs) {
  if (receipt?.kind === "explicit") {
    const minutes = Math.abs(receipt.timestamp - processEndMs) / 60_000;
    if (minutes <= 30) return { score: 0.6, code: "time_30m" };
    if (minutes <= 120) return { score: 0.45, code: "time_2h" };
    if (minutes <= 360) return { score: 0.25, code: "time_6h" };
    return { score: 0, code: "time_far" };
  }
  if (receipt?.kind === "time_only") {
    const parts = shanghaiParts(new Date(processEndMs));
    const minutes = clockDistance(receipt.clockMinutes, Number(parts.hour) * 60 + Number(parts.minute));
    if (minutes <= 30) return { score: 0.45, code: "clock_30m" };
    if (minutes <= 90) return { score: 0.3, code: "clock_90m" };
    if (minutes <= 180) return { score: 0.15, code: "clock_3h" };
  }
  return { score: 0, code: "time_missing" };
}

function energyScore(receiptEnergy, processEnergy) {
  const billed = number(receiptEnergy);
  const vehicle = number(processEnergy);
  if (billed === null || billed <= 0 || vehicle === null || vehicle <= 0) {
    return { score: 0.1, code: "energy_missing" };
  }
  const difference = Math.abs(billed - vehicle);
  if (difference <= Math.max(2, billed * 0.2)) return { score: 0.4, code: "energy_close" };
  if (difference <= Math.max(4, billed * 0.35)) return { score: 0.25, code: "energy_possible" };
  return { score: 0, code: "energy_far" };
}

function emptyMatch(accountingAt = null, accountingAtSource = null) {
  return {
    status: "unlinked",
    selected_process_id: null,
    confidence: null,
    candidates: [],
    accounting_at: accountingAt,
    accounting_at_source: accountingAtSource
  };
}

export function matchReceiptToChargingProcesses(fields = {}, processes = [], receivedAt = new Date()) {
  const parsedReceiptTime = receiptTime(fields.charged_at);
  const explicitAccountingAt = parsedReceiptTime?.kind === "explicit"
    ? parsedReceiptTime.accountingAt
    : null;
  const fallback = emptyMatch(explicitAccountingAt, explicitAccountingAt ? "explicit_receipt" : null);
  const receivedMs = new Date(receivedAt).getTime();
  if (!Number.isFinite(receivedMs)) return fallback;

  const candidates = (processes || []).flatMap((process) => {
    const endMs = utcMs(process?.end_at);
    if (
      endMs === null
      || endMs > receivedMs + 10 * 60_000
      || receivedMs - endMs > candidateWindowMs
    ) return [];
    const time = timeScore(parsedReceiptTime, endMs);
    const energy = energyScore(fields.energy_kwh, process.charge_energy_added);
    const score = Number((time.score + energy.score).toFixed(2));
    if (score < 0.35) return [];
    return [{
      process_id: String(process.id),
      end_at: process.end_at,
      display_at: shanghaiLabel(process.end_at),
      energy_kwh: number(process.charge_energy_added),
      score,
      reason_codes: [time.code, energy.code]
    }];
  }).sort((left, right) => right.score - left.score).slice(0, 3);

  if (candidates.length === 0) return fallback;
  const top = candidates[0];
  const runnerUp = candidates[1];
  const isUnique = top.score >= 0.7 && (!runnerUp || top.score - runnerUp.score >= 0.15);
  if (!isUnique) {
    return {
      status: "needs_confirmation",
      selected_process_id: null,
      confidence: top.score,
      candidates,
      accounting_at: explicitAccountingAt,
      accounting_at_source: explicitAccountingAt ? "explicit_receipt" : null
    };
  }
  return {
    status: "matched",
    selected_process_id: top.process_id,
    confidence: top.score,
    candidates: [top],
    accounting_at: explicitAccountingAt || top.display_at,
    accounting_at_source: explicitAccountingAt ? "explicit_receipt" : "matched_session"
  };
}
