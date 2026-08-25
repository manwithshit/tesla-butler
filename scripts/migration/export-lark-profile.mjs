import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function decryptStoredSecret(payload, key) {
  if (key.length !== 32 || payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error("飞书本地密钥存储格式无效。");
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function safeAccountFilename(account) {
  return `${account.replace(/[^a-zA-Z0-9._-]/g, "_")}.enc`;
}

export function exportLarkProfile({ home, profileName, outputPath }) {
  const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR || path.join(home, ".lark-cli");
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  const profile = config.apps?.find((app) => app.name === profileName);
  if (!profile || typeof profile.appId !== "string" || profile.appId.length === 0) {
    throw new Error(`找不到飞书 profile：${profileName}。`);
  }
  if (profile.appSecret?.source !== "keychain" || typeof profile.appSecret.id !== "string") {
    throw new Error("飞书 profile 未使用受支持的本地加密存储。");
  }

  const storageDir = path.join(home, "Library", "Application Support", "lark-cli");
  const key = fs.readFileSync(path.join(storageDir, "master.key.file"));
  const payload = fs.readFileSync(path.join(storageDir, safeAccountFilename(profile.appSecret.id)));
  const secret = decryptStoredSecret(payload, key);
  try {
    if (secret.length < 16 || secret.includes(0x0a) || secret.includes(0x0d)) {
      throw new Error("解密后的飞书 App Secret 未通过结构校验。");
    }
    const exported = {
      profile: profileName,
      app_id: profile.appId,
      app_secret: secret.toString("utf8"),
      brand: profile.brand || "feishu",
      lang: profile.lang || "zh_cn"
    };
    fs.writeFileSync(outputPath, JSON.stringify(exported), { mode: 0o600 });
  } finally {
    secret.fill(0);
    key.fill(0);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [profileName, outputPath] = process.argv.slice(2);
  if (!profileName || !outputPath) {
    process.stderr.write("用法：node export-lark-profile.mjs profile output\n");
    process.exit(2);
  }
  try {
    exportLarkProfile({ home: os.homedir(), profileName, outputPath });
    process.stdout.write("飞书 profile 已加入加密迁移暂存区。\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
