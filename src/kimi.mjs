import fs from "node:fs/promises";
import { config } from "./config.mjs";
import { normalizeReceiptResult, validateReceipt } from "./receipt-values.mjs";

function mimeFor(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  return "application/octet-stream";
}

function parseModelJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch (cause) {
    const error = new Error("Kimi model content contained invalid JSON", { cause });
    error.code = "KIMI_MODEL_JSON";
    error.retryable = true;
    throw error;
  }
  return normalizeReceiptResult(value);
}

function makeKimiError(message, code, retryable, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestChargingReceipt(image, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`${config.kimiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.kimiModel,
          temperature: 0,
          max_tokens: 900,
          messages: [{
            role: "user",
            content: [
              {
                type: "text",
                text: "这是电动车充电账单截图。只提取图上明确可见的数值，不要自行计算；如果图上没有直接显示充电电量，energy_kwh 填 null。不要提取地址、车牌、订单号或用户身份。只输出一个 JSON 对象，字段严格为 energy_kwh, amount_cny, electricity_fee_cny, service_fee_cny, electricity_unit_price_cny_per_kwh, service_unit_price_cny_per_kwh, all_in_unit_price_cny_per_kwh, charged_at, provider, confidence。字段分别是充电电量、实付总额、电费、服务费、电费单价、服务费单价、含服务费的综合单价、充电完成时间、运营商、置信度。未知字段填 null，confidence 为 0 到 1。"
              },
              {
                type: "image_url",
                image_url: { url: `data:${mimeFor(image)};base64,${image.toString("base64")}` }
              }
            ]
          }]
        })
      });
    } catch (cause) {
      const timeout = cause?.name === "AbortError";
      throw makeKimiError(
        timeout ? "Kimi request timed out" : "Kimi request failed",
        timeout ? "KIMI_TIMEOUT" : "KIMI_NETWORK",
        true,
        cause
      );
    }

    let rawPayload;
    try {
      rawPayload = await response.text();
    } catch (cause) {
      throw makeKimiError("Kimi response body could not be read", "KIMI_RESPONSE_READ", true, cause);
    }
    let payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch (cause) {
      throw makeKimiError("Kimi HTTP response contained invalid JSON", "KIMI_HTTP_JSON", true, cause);
    }
    if (!response.ok) {
      throw makeKimiError(
        `Kimi API ${response.status}`,
        "KIMI_HTTP_STATUS",
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }
    return parseModelJson(payload?.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeChargingReceipt(filePath, options = {}) {
  const image = await fs.readFile(filePath);
  const fetchImpl = options.fetchImpl || fetch;
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const retryDelayMs = options.retryDelayMs === undefined ? 300 : Math.max(0, Number(options.retryDelayMs) || 0);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 45_000);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestChargingReceipt(image, { fetchImpl, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts) break;
      await wait(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  lastError.attempts = attempts;
  throw lastError;
}

export { validateReceipt };
