import fs from "node:fs/promises";
import path from "node:path";
import { analyzeChargingReceipt, validateReceipt } from "./receipt-recognizer.mjs";
import { config, projectPath } from "./config.mjs";
import { enrichConfirmedReceipt, getConfirmedReceiptsNeedingEnrichment } from "./store.mjs";

function closeEnough(left, right, absoluteTolerance, relativeTolerance) {
  if (left === null || left === undefined || right === null || right === undefined) return true;
  const difference = Math.abs(Number(left) - Number(right));
  return difference <= Math.max(absoluteTolerance, Math.abs(Number(left)) * relativeTolerance);
}

const candidates = await getConfirmedReceiptsNeedingEnrichment();
const analyzed = [];
let skipped = 0;
for (const receipt of candidates) {
  try {
    const fields = await analyzeChargingReceipt(path.join(config.root, receipt.image_path));
    if (validateReceipt(fields)) {
      skipped += 1;
      continue;
    }
    if (!closeEnough(receipt.fields?.amount_cny, fields.amount_cny, 0.05, 0.01)
      || !closeEnough(receipt.fields?.energy_kwh, fields.energy_kwh, 0.1, 0.02)) {
      skipped += 1;
      continue;
    }
    analyzed.push({ id: receipt.id, fields });
  } catch {
    skipped += 1;
  }
}

if (analyzed.length > 0) {
  const backupDir = projectPath("data", "processed", "backups");
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(projectPath("data", "processed", "receipts.json"), path.join(backupDir, `receipts-before-v2-${stamp}.json`));
  for (const item of analyzed) await enrichConfirmedReceipt(item.id, item.fields);
}

process.stdout.write(`${JSON.stringify({ candidates: candidates.length, enriched: analyzed.length, skipped })}\n`);
