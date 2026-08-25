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

export async function recognizeTextWithVision(imagePath, options = {}) {
  const run = options.runFile || runFile;
  let binary;
  try {
    binary = options.binaryPath || await helperPath();
  } catch (cause) {
    const error = new Error("Apple Vision OCR helper could not be built", { cause });
    error.code = "VISION_UNAVAILABLE";
    throw error;
  }
  let stdout;
  try {
    ({ stdout } = await run(binary, [imagePath], { timeout: options.timeoutMs || 20_000 }));
  } catch (cause) {
    const error = new Error("Apple Vision OCR failed", { cause });
    error.code = "VISION_OCR_FAILED";
    throw error;
  }
  try {
    const observations = JSON.parse(stdout);
    if (!Array.isArray(observations)) throw new Error("not an array");
    return observations;
  } catch (cause) {
    const error = new Error("Apple Vision OCR returned invalid JSON", { cause });
    error.code = "VISION_RESPONSE_INVALID";
    throw error;
  }
}
