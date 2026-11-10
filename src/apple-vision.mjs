import fs from "node:fs/promises";
import path from "node:path";
import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";

const sourcePath = projectPath("scripts", "apple-vision-ocr.swift");
const binaryPath = projectPath("data", "processed", "bin", "apple-vision-ocr");
let compilePromise = null;

async function binaryIsCurrent() {
  try {
    const [source, binary] = await Promise.all([fs.stat(sourcePath), fs.stat(binaryPath)]);
    return binary.mtimeMs >= source.mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function compileHelper() {
  if (await binaryIsCurrent()) return binaryPath;
  await fs.mkdir(path.dirname(binaryPath), { recursive: true, mode: 0o700 });
  const temporary = `${binaryPath}.${process.pid}.tmp`;
  try {
    await runFile(config.xcrunCli, ["swiftc", "-O", sourcePath, "-o", temporary], { timeout: 120_000 });
    await fs.chmod(temporary, 0o700);
    await fs.rename(temporary, binaryPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return binaryPath;
}

async function helperPath() {
  if (!compilePromise) compilePromise = compileHelper().catch((error) => {
    compilePromise = null;
    throw error;
  });
  return compilePromise;
}

async function recognizeTextWithAppleVision(imagePath, options = {}) {
  const run = options.runFile || runFile;
  let binary;
  try {
    binary = options.binaryPath || await helperPath();
  } catch (cause) {
    const error = new Error("Apple Vision OCR helper could not be built", { cause });
    error.code = "VISION_UNAVAILABLE";
    error.ocrBackend = "apple-vision";
    throw error;
  }
  let stdout;
  try {
    ({ stdout } = await run(binary, [imagePath], { timeout: options.timeoutMs || 20_000 }));
  } catch (cause) {
    const error = new Error("Apple Vision OCR failed", { cause });
    error.code = "VISION_OCR_FAILED";
    error.ocrBackend = "apple-vision";
    throw error;
  }
  try {
    const observations = JSON.parse(stdout);
    if (!Array.isArray(observations)) throw new Error("not an array");
    return observations;
  } catch (cause) {
    const error = new Error("Apple Vision OCR returned invalid JSON", { cause });
    error.code = "VISION_RESPONSE_INVALID";
    error.ocrBackend = "apple-vision";
    throw error;
  }
}

function rapidOcrError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.ocrBackend = "rapidocr";
  return error;
}

// RapidOCR service returns [{text, confidence, box: [[x,y] x4]}]; the receipt
// parser only needs axis-aligned bounds, so collapse each polygon once here.
function flattenRapidOcrObservations(payload) {
  return payload.map((item) => {
    const box = Array.isArray(item?.box) ? item.box : [];
    const xs = box.map((point) => Number(point[0]));
    const ys = box.map((point) => Number(point[1]));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      text: String(item?.text ?? ""),
      confidence: Number(item?.confidence ?? 0),
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY
    };
  });
}

async function recognizeTextWithRapidOcr(imagePath, options = {}) {
  let image;
  try {
    image = await fs.readFile(imagePath);
  } catch (cause) {
    throw rapidOcrError("RapidOCR image could not be read", "VISION_UNAVAILABLE", cause);
  }
  let response;
  try {
    response = await fetch(`${config.rapidOcrUrl.replace(/\/$/, "")}/ocr`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: image,
      signal: AbortSignal.timeout(options.timeoutMs || config.rapidOcrTimeoutMs)
    });
  } catch (cause) {
    throw rapidOcrError("RapidOCR service request failed", "VISION_UNAVAILABLE", cause);
  }
  if (!response.ok) {
    throw rapidOcrError(`RapidOCR service returned ${response.status}`, "VISION_OCR_FAILED");
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw rapidOcrError("RapidOCR returned invalid JSON", "VISION_RESPONSE_INVALID", cause);
  }
  if (!Array.isArray(payload)) {
    throw rapidOcrError("RapidOCR response is not an array", "VISION_RESPONSE_INVALID");
  }
  return flattenRapidOcrObservations(payload);
}

export async function recognizeTextWithVision(imagePath, options = {}) {
  if (config.ocrBackend === "rapidocr") {
    return recognizeTextWithRapidOcr(imagePath, options);
  }
  return recognizeTextWithAppleVision(imagePath, options);
}
