import fs from "node:fs";
import fsp from "node:fs/promises";
import { projectPath } from "./config.mjs";

const SOURCE_URL = "https://www.autohome.com.cn/oil/110100.html";
const OFFICIAL_REFERENCE_URL = "https://fgw.beijing.gov.cn/fgwzwgk/2024zcwj/bwqtwj/202608/t20260814_4823165.htm";
const CACHE_PATH = projectPath("data", "processed", "reference-fuel-prices.json");

const fallbackReference = {
  display_date: "2026-08-25",
  effective_date: "2026-08-25",
  prices: { "92": 7.78, "95": 8.29, "98": 9.79 },
  price_scope: "北京统一参考基准",
  price_source: "北京当日参考价",
  source_url: SOURCE_URL,
  official_reference_url: OFFICIAL_REFERENCE_URL,
  fetched_at: null
};

function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validPrice(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 3 && Number(value) <= 20;
}

function validReference(value) {
  return value
    && /^\d{4}-\d{2}-\d{2}$/.test(String(value.display_date))
    && ["92", "95", "98"].every((grade) => validPrice(value.prices?.[grade]));
}

function loadCachedReference() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return validReference(parsed) ? parsed : fallbackReference;
  } catch {
    return fallbackReference;
  }
}

let currentReference = loadCachedReference();

export function parseBeijingFuelPricePage(html) {
  const text = String(html || "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const match = text.match(/(\d{4})年(\d{2})月(\d{2})日.*?92号汽油为\s*([\d.]+)\s*元.*?95号汽油为\s*([\d.]+)\s*元.*?98号汽油为\s*([\d.]+)\s*元/);
  if (!match) throw new Error("fuel price page incomplete");
  const prices = { "92": Number(match[4]), "95": Number(match[5]), "98": Number(match[6]) };
  if (!Object.values(prices).every(validPrice)) throw new Error("fuel price page contains invalid values");
  return {
    display_date: `${match[1]}-${match[2]}-${match[3]}`,
    prices
  };
}

export function getReferenceFuelPrices(now = new Date()) {
  return {
    ...currentReference,
    prices: { ...currentReference.prices },
    is_current_day: currentReference.display_date === shanghaiDate(now)
  };
}

export async function refreshReferenceFuelPrices({ fetchImpl = fetch, now = new Date(), force = false } = {}) {
  const today = shanghaiDate(now);
  if (!force && currentReference.display_date === today && currentReference.fetched_at) {
    return getReferenceFuelPrices(now);
  }
  const response = await fetchImpl(SOURCE_URL, {
    headers: { "user-agent": "TeslaSavingTicket/1.0 (+local reference price refresh)" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`fuel price refresh failed: HTTP ${response.status}`);
  const parsed = parseBeijingFuelPricePage(await response.text());
  if (parsed.display_date !== today) {
    throw new Error(`fuel price refresh returned stale date ${parsed.display_date}`);
  }
  currentReference = {
    ...parsed,
    effective_date: parsed.display_date,
    price_scope: "北京统一参考基准",
    price_source: "北京当日参考价",
    source_url: SOURCE_URL,
    official_reference_url: OFFICIAL_REFERENCE_URL,
    fetched_at: now.toISOString()
  };
  await fsp.mkdir(projectPath("data", "processed"), { recursive: true });
  const temp = `${CACHE_PATH}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(currentReference, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, CACHE_PATH);
  return getReferenceFuelPrices(now);
}
