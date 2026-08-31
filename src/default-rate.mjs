const decimalPattern = /^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/;

export function parseDefaultElectricityRate(value) {
  const raw = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!decimalPattern.test(raw)) return null;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 10) return null;
  return Number(rate.toFixed(4));
}

export function parseDefaultRateFormValue(formValue) {
  let value = formValue;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseDefaultElectricityRate(value.default_rate);
}

export function parseDefaultRateTextCommand(text) {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(
    /^(?:设置|修改)?\s*(?:默认|家庭|家用|常用)?\s*电价\s*(?:为|是|：|:)?\s*((?:0|[1-9]\d?)(?:\.\d{1,4})?)\s*(?:元\s*(?:\/|每)?\s*(?:度|kwh))?\s*$/i
  );
  return match ? parseDefaultElectricityRate(match[1]) : null;
}

export function formatDefaultElectricityRate(value) {
  const rate = parseDefaultElectricityRate(value);
  if (rate === null) return null;
  return rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
