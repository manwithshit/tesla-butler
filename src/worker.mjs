import { config } from "./config.mjs";
import { connect } from "mqtt";
import { handleCardEvent, handleMessageEvent, sendChargingEvent, sendScheduledReport } from "./bot.mjs";
import { ChargingTracker, parseTeslaMateTopic } from "./charging.mjs";
import { consumeLines } from "./lib/lines.mjs";
import { spawnStreaming } from "./lib/process.mjs";
import { ensureTeslaMate } from "./teslamate.mjs";
import { getRuntimeState, markScheduledPush, saveChargingMonitorState } from "./store.mjs";
import { eventDedupeKey } from "./events.mjs";
import { refreshReferenceFuelPrices } from "./fuel-prices.mjs";

let stopping = false;
const children = new Set();
const seen = new Set();
let mqttClient = null;
let chargingQueue = Promise.resolve();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function once(key) {
  if (!key || seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 2_000) seen.delete(seen.values().next().value);
  return true;
}

function startConsumer(eventKey, handler) {
  const child = spawnStreaming(config.larkCli, [
    "--profile", config.larkProfile,
    "event", "consume", eventKey,
    "--as", "bot"
  ], { cwd: config.root });
  children.add(child);

  consumeLines(child.stdout, (line) => {
    try {
      const event = JSON.parse(line);
      const key = eventDedupeKey(eventKey, event);
      if (!once(`${eventKey}:${key}`)) return;
      Promise.resolve(handler(event)).catch((error) => log(`${eventKey} handler failed: ${error.message}`));
    } catch {
      log(`${eventKey} emitted invalid JSON`);
    }
  });
  consumeLines(child.stderr, (line) => {
    if (line.includes("[event] ready") || line.includes("feishu-websocket: connected")) log(line.trim());
    else if (line.includes("\"ok\":false") || line.includes("WARN") || line.includes("exited")) log(`${eventKey}: ${line.trim().slice(0, 500)}`);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    log(`${eventKey} consumer exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    if (!stopping) setTimeout(() => startConsumer(eventKey, handler), 3_000);
  });
}

function shanghaiParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

async function checkScheduledPush() {
  const state = await getRuntimeState();
  if (!state.chat_id) return;
  const now = shanghaiParts();
  const dateKey = `${now.year}-${now.month}-${now.day}`;
  let period = null;
  let key = null;
  if (now.weekday === "Mon" && now.hour === "09" && now.minute === "00") {
    period = "previous_week";
    key = `weekly:${dateKey}`;
  } else if (now.day === "01" && now.hour === "09" && now.minute === "10") {
    period = "previous_month";
    key = `monthly:${now.year}-${now.month}`;
  }
  if (!period || state.sent?.[key]) return;
  await sendScheduledReport(state.chat_id, period, `scheduled:${key}`);
  await markScheduledPush(key);
  log(`scheduled ${period} report sent`);
}

async function startChargingMonitor() {
  const state = await getRuntimeState();
  const tracker = new ChargingTracker(state.charging_monitor);
  mqttClient = connect(config.mqttUrl, {
    clientId: `tesla-saving-ticket-${process.pid}`,
    clean: true,
    reconnectPeriod: 3_000,
    connectTimeout: 10_000
  });
  const topics = [
    "battery_level",
    "plugged_in",
    "charging_state",
    "charge_limit_soc",
    "charger_power",
    "charge_energy_added",
    "time_to_full_charge"
  ].map((field) => `teslamate/cars/+/${field}`);

  mqttClient.on("connect", () => {
    mqttClient.subscribe(topics, { qos: 0 }, (error) => {
      if (error) log(`MQTT subscribe failed: ${error.message}`);
      else log("MQTT charging monitor connected");
    });
  });
  mqttClient.on("error", (error) => log(`MQTT error: ${error.message}`));
  mqttClient.on("message", (topic, payload) => {
    const parsed = parseTeslaMateTopic(topic, payload.toString("utf8"));
    if (!parsed) return;
    chargingQueue = chargingQueue.then(async () => {
      const events = tracker.update(parsed.carId, parsed.field, parsed.value, new Date().toISOString());
      if (parsed.field === "charging_state" || events.length > 0) {
        await saveChargingMonitorState(tracker.toJSON());
      }
      for (const event of events) {
        setTimeout(async () => {
          try {
            const current = await getRuntimeState();
            if (!current.chat_id) {
              log(`charging ${event.type} skipped: no registered chat`);
              return;
            }
            if (!tracker.canSend(event, new Date().toISOString())) {
              log(`charging ${event.type} skipped: state changed or estimate stale`);
              return;
            }
            event.snapshot = tracker.snapshot(event.carId);
            await sendChargingEvent(current.chat_id, event, event.sessionId);
            log(`charging ${event.type} notification sent`);
          } catch (error) {
            log(`charging ${event.type} notification failed: ${error.message}`);
          }
        }, 750).unref();
      }
    }).catch((error) => log(`MQTT message failed: ${error.message}`));
  });
}

async function boot() {
  log(`worker starting profile=${config.larkProfile} ocr=apple-vision k3Fallback=${config.kimiFallbackEnabled ? config.kimiModel : "off"}`);
  await refreshReferenceFuelPrices()
    .then((reference) => log(`fuel reference ready date=${reference.display_date} current=${reference.is_current_day}`))
    .catch((error) => log(`fuel reference refresh failed: ${error.message}`));
  ensureTeslaMate().then(() => log("TeslaMate compose services ready")).catch((error) => log(`TeslaMate startup check failed: ${error.message}`));
  startConsumer("im.message.receive_v1", handleMessageEvent);
  startConsumer("card.action.trigger", handleCardEvent);
  startChargingMonitor().catch((error) => log(`MQTT charging monitor failed: ${error.message}`));
  setInterval(() => checkScheduledPush().catch((error) => log(`scheduler failed: ${error.message}`)), 60_000).unref();
  setInterval(() => refreshReferenceFuelPrices().catch((error) => log(`fuel reference refresh failed: ${error.message}`)), 6 * 60 * 60 * 1_000).unref();
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`worker stopping signal=${signal}`);
  for (const child of children) child.kill("SIGTERM");
  mqttClient?.end(true);
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => log(`uncaught exception: ${error.message}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.message || error}`));

await boot();
