const lifetimeMs = 72 * 60 * 60_000;
const limit = 2000;
const labels = ['event', 'field', 'phase', 'decision', 'reason'];
const flags = ['value', 'retained', 'db_active'];

function instant(value) {
  const text = String(value || '');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
}

function safeEntry(entry) {
  if (!entry || !Number.isFinite(instant(entry.at))) return null;
  const result = { at: new Date(instant(entry.at)).toISOString() };
  for (const field of labels) {
    if (typeof entry[field] === 'string' && /^[a-z_]{1,40}$/.test(entry[field])) result[field] = entry[field];
  }
  for (const field of flags) if (typeof entry[field] === 'boolean') result[field] = entry[field];
  if (Number.isInteger(entry.segment_count) && entry.segment_count >= 0) result.segment_count = entry.segment_count;
  return result;
}

export function pruneTripAudit(entries, at) {
  const cutoff = instant(at) - lifetimeMs;
  return (Array.isArray(entries) ? entries : []).map(safeEntry)
    .filter(entry => entry && Date.parse(entry.at) >= cutoff).slice(-limit);
}

export function appendTripAudit(entries, entry) {
  const previous = Array.isArray(entries) ? entries : [];
  const horizon = Math.max(instant(entry.at), ...previous.map(row => instant(row.at)).filter(Number.isFinite));
  return pruneTripAudit([...previous, entry], new Date(horizon).toISOString());
}
