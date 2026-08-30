import crypto from "node:crypto";
import fs from "node:fs/promises";
import { projectPath } from "./config.mjs";

const storePath = projectPath("data", "processed", "receipts.json");
const runtimePath = projectPath("data", "processed", "runtime-state.json");
let runtimeQueue = Promise.resolve();

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { receipts: {} };
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(projectPath("data", "processed"), { recursive: true });
  const temp = `${storePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, storePath);
}

export function opaqueId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function normalizeReceiptFields(fields, receivedAt = new Date()) {
  const normalized = { ...fields };
  const raw = String(fields?.charged_at || "").trim();
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    normalized.charged_at = raw;
    normalized.charged_at_source = fields.charged_at_source || "time_only";
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(raw)) {
    normalized.charged_at = raw.replace("T", " ").replace(/([+-]\d{2}:?\d{2}|Z)$/i, "");
    normalized.charged_at_source = fields.charged_at_source || "explicit";
    if (!normalized.accounting_at) {
      normalized.accounting_at = normalized.charged_at;
      normalized.accounting_at_source = normalized.charged_at_source === "explicit"
        ? "explicit_receipt"
        : normalized.charged_at_source;
    }
  }
  return normalized;
}

export function mergeReceiptEnrichment(existingFields, analyzedFields, receivedAt) {
  const merged = { ...existingFields };
  for (const [key, value] of Object.entries(analyzedFields || {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  merged.amount_cny = existingFields?.amount_cny ?? analyzedFields?.amount_cny ?? null;
  merged.energy_kwh = existingFields?.energy_kwh ?? analyzedFields?.energy_kwh ?? null;
  return normalizeReceiptFields(merged, receivedAt);
}

export function applyReceiptChargingMatch(receipt, match, method = "automatic") {
  receipt.schema_version = 3;
  receipt.fields ||= {};
  const selectedProcessId = match?.selected_process_id === null || match?.selected_process_id === undefined
    ? null
    : String(match.selected_process_id);
  receipt.charging_match = {
    status: match?.status || "unlinked",
    selected_process_id: selectedProcessId,
    method: selectedProcessId ? method : "none",
    confidence: match?.confidence !== null && match?.confidence !== undefined && Number.isFinite(Number(match.confidence))
      ? Number(match.confidence)
      : null,
    candidates: (match?.candidates || []).map((candidate) => ({ ...candidate }))
  };
  if (match?.accounting_at && receipt.fields.accounting_at_source !== "explicit_receipt") {
    receipt.fields.accounting_at = match.accounting_at;
    receipt.fields.accounting_at_source = match.accounting_at_source || "matched_session";
  }
  return receipt;
}

export function selectReceiptChargingCandidate(receipt, processId) {
  const candidate = receipt?.charging_match?.candidates?.find(
    (item) => String(item.process_id) === String(processId)
  );
  if (!candidate) return false;
  receipt.fields ||= {};
  receipt.charging_match.status = "matched";
  receipt.charging_match.selected_process_id = String(candidate.process_id);
  receipt.charging_match.method = "user_selected";
  receipt.charging_match.confidence = candidate.score !== null && candidate.score !== undefined && Number.isFinite(Number(candidate.score))
    ? Number(candidate.score)
    : null;
  if (candidate.display_at && receipt.fields.accounting_at_source !== "explicit_receipt") {
    receipt.fields.accounting_at = candidate.display_at;
    receipt.fields.accounting_at_source = "matched_session";
  }
  return true;
}

function shanghaiDateTimeString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function ensureReceiptAccounting(receipt) {
  receipt.fields ||= {};
  if (receipt.fields.accounting_at) return receipt;
  const createdAt = new Date(receipt.created_at);
  const fallback = Number.isFinite(createdAt.getTime()) ? createdAt : new Date();
  const timeOnly = String(receipt.fields.charged_at || "").trim().match(/^(\d{1,2}:\d{2})(?::\d{2})?$/);
  receipt.fields.accounting_at = timeOnly
    ? `${shanghaiDateString(fallback)} ${timeOnly[1].padStart(5, "0")}`
    : shanghaiDateTimeString(fallback);
  receipt.fields.accounting_at_source = "received_date_fallback";
  return receipt;
}

export async function savePendingReceipt({ messageId, imagePath, fields, chargingMatch, receivedAt = new Date() }) {
  const store = await readStore();
  const id = opaqueId(messageId);
  const createdAt = new Date(receivedAt);
  const receipt = {
    id,
    source_message_hash: opaqueId(messageId),
    image_path: imagePath,
    status: "pending",
    fields: normalizeReceiptFields(fields, createdAt),
    created_at: createdAt.toISOString()
  };
  applyReceiptChargingMatch(receipt, chargingMatch);
  store.receipts[id] = receipt;
  await writeStore(store);
  return store.receipts[id];
}

export async function getReceipt(id) {
  const store = await readStore();
  return store.receipts[id] || null;
}

export async function selectReceiptChargingMatch(id, processId) {
  const store = await readStore();
  const receipt = store.receipts[id];
  if (!receipt || receipt.status !== "pending") return null;
  if (!selectReceiptChargingCandidate(receipt, processId)) return null;
  receipt.updated_at = new Date().toISOString();
  await writeStore(store);
  return receipt;
}

export async function setReceiptStatus(id, status) {
  if (!new Set(["confirmed", "ignored"]).has(status)) throw new Error("invalid receipt status");
  const store = await readStore();
  const receipt = store.receipts[id];
  if (!receipt) return null;
  if (status === "confirmed") {
    ensureReceiptAccounting(receipt);
    if (receipt.charging_match?.status === "needs_confirmation") {
      receipt.charging_match.status = "unlinked";
      receipt.charging_match.selected_process_id = null;
      receipt.charging_match.method = "user_skipped";
      receipt.charging_match.confidence = null;
    }
  }
  receipt.status = status;
  receipt.updated_at = new Date().toISOString();
  await writeStore(store);
  return receipt;
}

export async function getConfirmedReceiptsNeedingEnrichment() {
  const store = await readStore();
  return Object.values(store.receipts).filter((receipt) =>
    receipt.status === "confirmed"
    && (
      receipt.fields?.electricity_fee_cny === undefined
      || receipt.fields?.service_fee_cny === undefined
      || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(receipt.fields?.charged_at || "").trim())
    )
  );
}

export async function enrichConfirmedReceipt(id, analyzedFields) {
  const store = await readStore();
  const receipt = store.receipts[id];
  if (!receipt || receipt.status !== "confirmed") return null;
  receipt.fields = mergeReceiptEnrichment(receipt.fields, analyzedFields, new Date(receipt.created_at));
  receipt.schema_version = 2;
  receipt.enriched_at = new Date().toISOString();
  await writeStore(store);
  return receipt;
}

function shanghaiDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function receiptChargedAt(receipt) {
  const raw = String(receipt.fields?.accounting_at || receipt.fields?.charged_at || "").trim();
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    const time = raw.length === 5 ? `${raw}:00` : raw;
    return new Date(`${shanghaiDateString(new Date(receipt.created_at))}T${time}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?/.test(raw)) {
    const normalized = raw.replace(" ", "T");
    return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
  }
  return new Date(receipt.created_at);
}

export async function getReceiptTotals(period, options = {}) {
  const store = options.store || await readStore();
  const now = options.now || new Date();
  const start = new Date(now);
  let end = null;
  if (period === "week") {
    const day = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - day);
  } else if (period === "previous_week") {
    const day = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - day);
    end = new Date(start);
    start.setDate(start.getDate() - 7);
  } else if (period === "month") {
    start.setDate(1);
  } else if (period === "previous_month") {
    start.setDate(1);
    end = new Date(start);
    start.setMonth(start.getMonth() - 1);
  } else {
    throw new Error(`unsupported period: ${period}`);
  }
  start.setHours(0, 0, 0, 0);
  if (end) end.setHours(0, 0, 0, 0);

  const confirmed = Object.values(store.receipts).filter((receipt) => {
    if (receipt.status !== "confirmed") return false;
    const chargedAt = receiptChargedAt(receipt);
    return Number.isFinite(chargedAt.getTime()) && chargedAt >= start && (!end || chargedAt < end);
  });
  const sum = (field) => Number(confirmed.reduce((total, item) => total + (Number(item.fields?.[field]) || 0), 0).toFixed(2));
  const amount = sum("amount_cny");
  const energy = sum("energy_kwh");
  return {
    count: confirmed.length,
    amount_cny: amount,
    energy_kwh: energy,
    electricity_fee_cny: sum("electricity_fee_cny"),
    service_fee_cny: sum("service_fee_cny"),
    all_in_unit_price_cny_per_kwh: energy > 0 ? Number((amount / energy).toFixed(2)) : null
  };
}

export async function registerChat(chatId) {
  if (!chatId) return;
  await updateRuntimeState((state) => {
    state.chat_id = chatId;
    return state;
  });
}

export async function getRuntimeState() {
  try {
    return JSON.parse(await fs.readFile(runtimePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { sent: {} };
    throw error;
  }
}

export async function markScheduledPush(key) {
  await updateRuntimeState((state) => {
    state.sent[key] = new Date().toISOString();
    return state;
  });
}

export async function getRouteImageCache() {
  const state = await getRuntimeState();
  return state.route_image_cache || {};
}

export async function setRouteImageCacheEntry(key, entry) {
  await updateRuntimeState((state) => {
    state.route_image_cache ||= {};
    state.route_image_cache[key] = entry;
    const entries = Object.entries(state.route_image_cache);
    if (entries.length > 100) {
      entries
        .sort(([, left], [, right]) => String(left.cached_at || "").localeCompare(String(right.cached_at || "")))
        .slice(0, entries.length - 100)
        .forEach(([oldKey]) => delete state.route_image_cache[oldKey]);
    }
    return state;
  });
}

async function writeRuntimeState(state) {
  await fs.mkdir(projectPath("data", "processed"), { recursive: true });
  const temp = `${runtimePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, runtimePath);
}

function updateRuntimeState(mutator) {
  const operation = runtimeQueue.then(async () => {
    const state = await getRuntimeState();
    state.sent ||= {};
    const next = await mutator(state) || state;
    await writeRuntimeState(next);
    return next;
  });
  runtimeQueue = operation.catch(() => {});
  return operation;
}

export async function saveChargingMonitorState(chargingMonitor) {
  await updateRuntimeState((state) => {
    state.charging_monitor = chargingMonitor;
    return state;
  });
}

export async function saveTripMonitorState(tripMonitor) {
  await updateRuntimeState((state) => {
    state.trip_monitor = tripMonitor;
    return state;
  });
}
