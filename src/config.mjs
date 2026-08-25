import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const config = Object.freeze({
  root: process.env.TICKET_PROJECT_ROOT || path.resolve(srcDir, ".."),
  larkCli: process.env.LARK_CLI || "/usr/local/bin/lark-cli",
  larkProfile: process.env.LARK_PROFILE || "tesla-saving-ticket",
  dockerCli: process.env.DOCKER_CLI || "/usr/local/bin/docker",
  nodeCli: process.env.NODE_CLI || "/usr/local/bin/node",
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
