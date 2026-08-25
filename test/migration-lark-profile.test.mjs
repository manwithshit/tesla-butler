import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportLarkProfile } from "../scripts/migration/export-lark-profile.mjs";

function encryptStoredSecret(secret, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

test("migration exports the real encrypted Lark secret instead of a masked config value", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tesla-lark-export-"));
  try {
    const configDir = path.join(home, ".lark-cli");
    const storageDir = path.join(home, "Library", "Application Support", "lark-cli");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    const account = "appsecret:cli_test";
    const key = crypto.randomBytes(32);
    const secret = "real-test-app-secret";
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      apps: [{
        name: "tesla-saving-ticket",
        appId: "cli_test",
        appSecret: { source: "keychain", id: account },
        brand: "feishu",
        lang: "zh_cn"
      }]
    }));
    fs.writeFileSync(path.join(storageDir, "master.key.file"), key);
    fs.writeFileSync(
      path.join(storageDir, "appsecret_cli_test.enc"),
      encryptStoredSecret(secret, key)
    );

    const outputPath = path.join(home, "profile.json");
    exportLarkProfile({ home, profileName: "tesla-saving-ticket", outputPath });
    const exported = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(exported.app_id, "cli_test");
    assert.equal(exported.app_secret, secret);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
