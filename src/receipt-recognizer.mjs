import { config } from "./config.mjs";
import { recognizeTextWithVision } from "./apple-vision.mjs";
import { analyzeChargingReceipt as analyzeWithK3Default } from "./kimi.mjs";
import { normalizeReceiptResult, validateReceipt } from "./receipt-values.mjs";

function numeric(text) {
  const match = String(text || "").replace(/,/g, "").trim().match(/^[¥￥]?\s*(-?\d+(?:\.\d+)?)\s*(?:元|度|kwh)?$/i);
  return match ? Number(match[1]) : null;
}

function sameRowValue(observations, labelPatterns) {
  const label = observations.find((item) => labelPatterns.some((pattern) => pattern.test(item.text)));
  if (!label) return { value: null, confidence: null };
  const stripped = labelPatterns.reduce((text, pattern) => text.replace(pattern, ""), label.text).replace(/^\s*[:：]\s*/, "");
  const inline = numeric(stripped);
  if (inline !== null) return { value: inline, confidence: label.confidence };
  if (stripped.trim()) return { value: null, confidence: null };
  const center = label.y + label.height / 2;
  const candidates = observations
    .filter((item) => item !== label && item.x >= label.x + label.width * 0.5 && numeric(item.text) !== null)
    .map((item) => ({ item, delta: Math.abs(item.y + item.height / 2 - center) }))
    .filter(({ item, delta }) => delta <= Math.max(0.015, label.height * 0.5, item.height * 0.5))
    .sort((left, right) => left.delta - right.delta || left.item.x - right.item.x);
  const match = candidates.length === 1 ? candidates[0].item : null;
  return match ? { value: numeric(match.text), confidence: Math.min(label.confidence, match.confidence) } : { value: null, confidence: null };
}

function matchNumber(observations, pattern) {
  for (const item of observations) {
    const match = String(item.text || "").replace(/,/g, "").match(pattern);
    if (match) return { value: Number(match[1]), confidence: item.confidence };
  }
  return { value: null, confidence: null };
}

function matchTime(observations) {
  for (const item of observations) {
    const ended = String(item.text || "").match(/结束时间\s*[:：]?\s*20\d{2}-\d{1,2}-\d{1,2}\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (ended) return { value: ended[1], confidence: item.confidence };
    const range = String(item.text || "").match(/(\d{1,2}:\d{2})\s*[~～—–-]\s*(\d{1,2}:\d{2})/);
    if (range) return { value: range[2], confidence: item.confidence };
  }
  return { value: null, confidence: null };
}

function matchDate(observations) {
  for (const item of observations) {
    const normalized = String(item.text || "").replace(/[/.]/g, "-");
    const numericDate = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    const chineseDate = String(item.text || "").match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    const match = numericDate || chineseDate;
    if (!match) continue;
    const month = String(match[2]).padStart(2, "0");
    const day = String(match[3]).padStart(2, "0");
    return { value: `${match[1]}-${month}-${day}`, confidence: item.confidence };
  }
  return { value: null, confidence: null };
}

function firstValue(...matches) {
  return matches.find((item) => item.value !== null) || { value: null, confidence: null };
}

export function parseVisionReceipt(rawObservations) {
  const observations = (rawObservations || [])
    .filter((item) => typeof item?.text === "string" && item.text.trim())
    .map((item) => ({ ...item, confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0 }));
  const texts = observations.map((item) => item.text.replace(/\s/g, ""));
  if (texts.some((text) => /订单中心|订单列表|待支付|待付款|未支付|未付款|立即支付|去支付/.test(text))
    || (texts.some((text) => text.includes("订单详情")) && texts.some((text) => text === "充电订单"))
    || texts.filter((text) => /订单(?:编号|号)\s*[:：]/.test(text)).length > 1) {
    const error = new Error("请发送单笔已支付的充电账单详情截图，不要拼接多笔订单或发送待支付页面。");
    error.code = "RECEIPT_IMAGE_UNSAFE";
    throw error;
  }
  const amount = firstValue(
    sameRowValue(observations, [/^(?:实付金额|实付款|实付|实际支付|支付金额)/]),
    sameRowValue(observations, [/^(?:总费用|合计|总计)/])
  );
  const energy = firstValue(
    matchNumber(observations, /(?:充电电量|充入电量|充电量)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:kwh|度)/i),
    sameRowValue(observations, [/^(?:充电电量|充入电量|充电量|已充电量)/])
  );
  const electricityFee = sameRowValue(observations, [/^(?:原始电费|电费金额|电费合计|充电费用|电费)/]);
  const serviceFee = sameRowValue(observations, [/^(?:原始服务费|服务费金额|服务费合计|服务费用|服务费)/]);
  const unitObservations = observations.filter((item) => /单价|\/\s*(?:度|kwh)|[|｜]/i.test(item.text));
  const electricityUnit = matchNumber(unitObservations, /电费\s*[:：]\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  const serviceUnit = matchNumber(unitObservations, /服务费\s*[:：]\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  const allInUnit = matchNumber(observations, /[¥￥]\s*(\d+(?:\.\d+)?)\s*\/\s*(?:度|kwh)/i);
  const chargedTime = matchTime(observations);
  const chargedDate = matchDate(observations);
  const chargedAt = {
    value: chargedDate.value && chargedTime.value
      ? `${chargedDate.value} ${chargedTime.value}`
      : chargedTime.value,
    confidence: chargedDate.value && chargedTime.value
      ? Math.min(chargedDate.confidence, chargedTime.confidence)
      : chargedTime.confidence
  };
  const draft = normalizeReceiptResult({
    amount_cny: amount.value,
    energy_kwh: energy.value,
    electricity_fee_cny: electricityFee.value,
    service_fee_cny: serviceFee.value,
    electricity_unit_price_cny_per_kwh: electricityUnit.value,
    service_unit_price_cny_per_kwh: serviceUnit.value,
    all_in_unit_price_cny_per_kwh: allInUnit.value,
    charged_at: chargedAt.value,
    provider: null,
    confidence: null
  }, "apple_vision");
  let completeness = 0;
  if (draft.amount_cny !== null) completeness += 0.35;
  if (draft.energy_kwh !== null) completeness += 0.25;
  if (draft.electricity_fee_cny !== null && draft.service_fee_cny !== null) completeness += 0.15;
  if (draft.all_in_unit_price_cny_per_kwh !== null
    && draft.electricity_unit_price_cny_per_kwh !== null
    && draft.service_unit_price_cny_per_kwh !== null) completeness += 0.15;
  if (draft.charged_at !== null) completeness += 0.1;
  draft.confidence = Number(completeness.toFixed(2));
  return draft;
}

function incompleteVisionError(message) {
  const error = new Error(message);
  error.code = "VISION_INCOMPLETE";
  return error;
}

export async function analyzeChargingReceipt(filePath, options = {}) {
  const recognizeText = options.recognizeText || recognizeTextWithVision;
  const analyzeWithK3 = options.analyzeWithK3 || analyzeWithK3Default;
  const k3FallbackEnabled = options.k3FallbackEnabled ?? config.kimiFallbackEnabled;
  let visionError;
  try {
    const local = parseVisionReceipt(await recognizeText(filePath));
    const validationError = validateReceipt(local);
    if (validationError) throw incompleteVisionError(validationError);
    return local;
  } catch (error) {
    if (error.code === "RECEIPT_IMAGE_UNSAFE") throw error;
    visionError = error;
  }

  if (!k3FallbackEnabled) {
    const error = new Error(`本地 OCR 未能完整识别账单：${visionError.message}`, { cause: visionError });
    error.code = "RECEIPT_RECOGNITION_INCOMPLETE";
    error.visionCode = visionError.code || "VISION_UNKNOWN";
    throw error;
  }

  try {
    return normalizeReceiptResult(await analyzeWithK3(filePath), "k3_fallback");
  } catch (k3Error) {
    const error = new Error("Apple Vision 与 K3 均未能识别账单", { cause: k3Error });
    error.code = "RECEIPT_RECOGNITION_FAILED";
    error.visionCode = visionError.code || "VISION_UNKNOWN";
    error.k3Code = k3Error.code || "K3_UNKNOWN";
    throw error;
  }
}

export { validateReceipt };
