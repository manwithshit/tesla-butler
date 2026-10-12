import path from "node:path";
import os from "node:os";
import { resolveCli } from "./cli-path.mjs";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const config = Object.freeze({
  root: process.env.TICKET_PROJECT_ROOT || path.resolve(srcDir, ".."),
  larkCli: resolveCli("lark-cli", { override: process.env.LARK_CLI, fallbacks: [path.join(os.homedir(), ".local/bin/lark-cli"), "/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli"] }),
  larkProfile: process.env.LARK_PROFILE || "tesla-saving-ticket",
  dockerCli: resolveCli("docker", { override: process.env.DOCKER_CLI, fallbacks: ["/opt/homebrew/bin/docker", "/usr/local/bin/docker", path.join(os.homedir(), ".docker/bin/docker"), "/Applications/Docker.app/Contents/Resources/bin/docker"] }),
  nodeCli: process.env.NODE_CLI || process.execPath,
  chromeCli: process.env.CHROME_CLI || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  xcrunCli: process.env.XCRUN_CLI || "/usr/bin/xcrun",
  kimiBaseUrl: process.env.KIMI_BASE_URL || "http://127.0.0.1:10100/v1",
  kimiModel: process.env.KIMI_MODEL || "kimi/k3",
  kimiFallbackEnabled: process.env.KIMI_FALLBACK_ENABLED === undefined
    ? Boolean(process.env.KIMI_BASE_URL)
    : process.env.KIMI_FALLBACK_ENABLED === "1",
  mqttUrl: process.env.MQTT_URL || "mqtt://127.0.0.1:1883",
  timeZone: "Asia/Shanghai"
});

export function projectPath(...parts) {
  return path.join(config.root, ...parts);
}
