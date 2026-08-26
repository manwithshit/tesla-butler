import { config } from "./config.mjs";
import { connect } from "mqtt";
import { handleCardEvent, handleMessageEvent, sendChargingEvent, sendCompletedTrip, sendScheduledReport } from "./bot.mjs";
import { ChargingTracker, parseTeslaMateTopic } from "./charging.mjs";
import { createChargingDatabaseMonitor, deliverPendingChargingEvents } from "./charging-monitor.mjs";
import { consumeLines } from "./lib/lines.mjs";
import { spawnStreaming } from "./lib/process.mjs";
import { ensureTeslaMate, getDriveGroup, getDriveMonitorSnapshot, getLatestChargingProcess } from "./teslamate.mjs";
import { getRuntimeState, markScheduledPush, saveChargingMonitorState, saveTripMonitorState } from "./store.mjs";
import { createTripDatabaseMonitor } from "./trip-monitor.mjs";
import { TripSessionTracker, tripBoundaryDefaults } from "./trip-session.mjs";
import { parseVehicleSignalTopic, tripSignalTopics } from "./vehicle-signals.mjs";
import { eventDedupeKey } from "./events.mjs";
import { refreshReferenceFuelPrices } from "./fuel-prices.mjs";
import { dueScheduledReport } from "./schedule.mjs";

let stopping = false;
const children = new Set();
const seen = new Set();
let mqttClient = null;
let chargingQueue = Promise.resolve();
let chargingTracker = null;
let checkChargingDatabase = null;
let tripQueue = Promise.resolve();
let tripTracker = null;
let checkTripDatabase = null;

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
  const due = dueScheduledReport(now, state);
  if (!due) return;
  await sendScheduledReport(state.chat_id, due.period, `scheduled:${due.key}`);
  await markScheduledPush(due.key);
  log(`scheduled ${due.period} report sent`);
}

async function deliverChargingQueue(source, at = new Date().toISOString()) {
  const result = await deliverPendingChargingEvents({
    tracker: chargingTracker,
    getRuntimeState,
    saveState: saveChargingMonitorState,
    sendEvent: async (chatId, event, key) => {
      await sendChargingEvent(chatId, event, key);
      log(`charging ${event.type} notification sent source=${source}`);
    },
    at
  });
  if (result.status === "no_chat") log(`charging notification pending: no registered chat source=${source}`);
  if (result.discarded > 0) log(`charging stale notification discarded count=${result.discarded} source=${source}`);
  return result;
}

function enqueueCharging(operation) {
  const queued = chargingQueue.then(operation);
  chargingQueue = queued.catch(() => {});
  return queued;
}

function enqueueTrip(operation) {
  const queued = tripQueue.then(operation);
  tripQueue = queued.catch(() => {});
  return queued;
}

async function persistTripMutation(operation) {
  if (!tripTracker) return false;
  const before = JSON.stringify(tripTracker.toJSON());
  const changed = operation();
  if (changed || JSON.stringify(tripTracker.toJSON()) !== before) {
    await saveTripMonitorState(tripTracker.toJSON());
    return true;
  }
  return false;
}

async function observeTripChargingEvents(events, observedAt) {
  if (!events.some((event) => event.type === "started")) return false;
  return enqueueTrip(() => persistTripMutation(() => tripTracker?.observeChargingStarted(observedAt)));
}

async function startTripMonitor() {
  const state = await getRuntimeState();
  tripTracker = new TripSessionTracker(state.trip_monitor);
  checkTripDatabase = createTripDatabaseMonitor({
    tracker: tripTracker,
    getSnapshot: getDriveMonitorSnapshot,
    getTrip: (segmentIds) => getDriveGroup(segmentIds, {
      pauseMs: tripBoundaryDefaults.inactivityTimeoutMs,
      endpointMeters: 100
    }),
    getRuntimeState,
    saveState: saveTripMonitorState,
    sendTrip: async (chatId, event, key) => {
      await sendCompletedTrip(chatId, event, key);
      log(`trip notification sent segments=${event.trip.segment_ids.length}`);
    }
  });
  const result = await enqueueTrip(() => checkTripDatabase());
  log(`trip database monitor ready status=${result.status}`);
}

async function startChargingMonitor() {
  const state = await getRuntimeState();
  chargingTracker = new ChargingTracker(state.charging_monitor);
  checkChargingDatabase = createChargingDatabaseMonitor({
    tracker: chargingTracker,
    getLatestProcess: getLatestChargingProcess,
    getRuntimeState,
    saveState: saveChargingMonitorState,
    sendEvent: async (chatId, event, key) => {
      await sendChargingEvent(chatId, event, key);
      log(`charging ${event.type} notification sent source=database`);
    },
    onEvents: observeTripChargingEvents
  });
  mqttClient = connect(config.mqttUrl, {
    clientId: `tesla-saving-ticket-${process.pid}`,
    clean: true,
    reconnectPeriod: 3_000,
    connectTimeout: 10_000
  });
  const chargingTopics = [
    "battery_level",
    "plugged_in",
    "charging_state",
    "charge_limit_soc",
    "charger_power",
    "charge_energy_added",
    "time_to_full_charge"
  ].map((field) => `teslamate/cars/+/${field}`);
  const topics = [...chargingTopics, ...tripSignalTopics];

  mqttClient.on("connect", () => {
    mqttClient.subscribe(topics, { qos: 0 }, (error) => {
      if (error) log(`MQTT subscribe failed: ${error.message}`);
      else log("MQTT charging and trip monitors connected");
    });
  });
  mqttClient.on("error", (error) => log(`MQTT error: ${error.message}`));
  mqttClient.on("message", (topic, payload, packet) => {
    const observedAt = new Date().toISOString();
    const tripSignal = parseVehicleSignalTopic(topic, payload.toString("utf8"));
    if (tripSignal) {
      enqueueTrip(async () => {
        if (checkTripDatabase) await checkTripDatabase();
        return persistTripMutation(() => tripTracker?.observeVehicleSignal(
          tripSignal.field,
          tripSignal.value,
          observedAt,
          { retained: Boolean(packet?.retain) }
        ));
      }).catch((error) => log(`trip signal check failed: ${error.message}`));
    }
    const parsed = parseTeslaMateTopic(topic, payload.toString("utf8"));
    if (!parsed) return;
    enqueueCharging(async () => {
      const events = chargingTracker.update(parsed.carId, parsed.field, parsed.value, observedAt);
      if (parsed.field === "charging_state" || events.length > 0) {
        await saveChargingMonitorState(chargingTracker.toJSON());
      }
      await observeTripChargingEvents(events, observedAt);
      await deliverChargingQueue("mqtt", observedAt);
    }).catch((error) => log(`MQTT message failed: ${error.message}`));
  });

  await enqueueCharging(() => checkChargingDatabase())
    .then((result) => log(`charging database monitor ready status=${result.status}`))
    .catch((error) => log(`charging database initial check failed: ${error.message}`));
}

async function boot() {
  log(`worker starting profile=${config.larkProfile} ocr=apple-vision k3Fallback=${config.kimiFallbackEnabled ? config.kimiModel : "off"}`);
  await refreshReferenceFuelPrices()
    .then((reference) => log(`fuel reference ready date=${reference.display_date} current=${reference.is_current_day}`))
    .catch((error) => log(`fuel reference refresh failed: ${error.message}`));
  ensureTeslaMate().then(() => log("TeslaMate compose services ready")).catch((error) => log(`TeslaMate startup check failed: ${error.message}`));
  startConsumer("im.message.receive_v1", handleMessageEvent);
  startConsumer("card.action.trigger", handleCardEvent);
  await startTripMonitor().catch((error) => log(`trip monitor failed: ${error.message}`));
  await startChargingMonitor().catch((error) => log(`charging monitor failed: ${error.message}`));
  checkScheduledPush().catch((error) => log(`scheduler failed: ${error.message}`));
  setInterval(() => checkScheduledPush().catch((error) => log(`scheduler failed: ${error.message}`)), 60_000).unref();
  setInterval(() => {
    if (!checkChargingDatabase) return;
    enqueueCharging(() => checkChargingDatabase())
      .catch((error) => log(`charging database check failed: ${error.message}`));
  }, 60_000).unref();
  setInterval(() => {
    if (!checkTripDatabase) return;
    enqueueTrip(() => checkTripDatabase())
      .catch((error) => log(`trip database check failed: ${error.message}`));
  }, tripBoundaryDefaults.pollMs).unref();
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
