import { config } from "./config.mjs";
import { randomUUID } from 'node:crypto';
import { createEventProcessor, createSerialQueue, safeErrorCode } from './worker-runtime.mjs';
import { connect } from "mqtt";
import { handleCardEvent, handleMessageEvent, retryPendingMapCards, sendChargingEvent, sendCompletedTrip, sendScheduledReport } from "./bot.mjs";
import { ChargingTracker, parseTeslaMateTopic } from "./charging.mjs";
import { createChargingDatabaseMonitor, deliverPendingChargingEvents } from "./charging-monitor.mjs";
import { consumeLines } from "./lib/lines.mjs";
import { spawnStreaming } from "./lib/process.mjs";
import { ensureTeslaMate, getDriveGroup, getDriveMonitorSnapshot, getLatestChargingProcess } from "./teslamate.mjs";
import { appendTripSignal, getRuntimeState, markScheduledPush, saveChargingMonitorState, saveTripMonitorState } from "./store.mjs";
import { createTripDatabaseMonitor } from "./trip-monitor.mjs";
import { summarizeTripState, TripSessionTracker, tripBoundaryDefaults } from "./trip-session.mjs";
import { parseVehicleSignalTopic, tripSignalTopics } from "./vehicle-signals.mjs";
import { eventDedupeKey } from "./events.mjs";
import { refreshReferenceFuelPrices } from "./fuel-prices.mjs";
import { dueScheduledReport } from "./schedule.mjs";

let stopping = false;
const children = new Set();
const processEvent = createEventProcessor();
const timers = new Set();
const signalWrites = createSerialQueue();
const schedulerQueue = createSerialQueue();
const mapRepairQueue = createSerialQueue();
let mqttClient = null;
const chargingQueue = createSerialQueue();
let chargingTracker = null;
let checkChargingDatabase = null;
const tripQueue = createSerialQueue();
let tripTracker = null;
let checkTripDatabase = null;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function startConsumer(eventKey, handler) {
  if (stopping) return;
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
      if (stopping || !key) return;
      processEvent(`${eventKey}:${key}`, () => handler(event))
        .catch((error) => log(`${eventKey} handler failed code=${safeErrorCode(error)}`));
    } catch {
      log(`${eventKey} emitted invalid JSON`);
    }
  });
  consumeLines(child.stderr, (line) => {
    if (line.includes('[event] ready')) log(`${eventKey} [event] ready`);
    else if (line.includes('feishu-websocket: connected')) log(`${eventKey} feishu-websocket: connected`);
    else if (line.includes('"ok":false') || line.includes('WARN') || line.includes('exited')) log(`${eventKey} consumer warning`);
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
  return chargingQueue.enqueue(operation);
}

function enqueueTrip(operation, key) {
  return tripQueue.enqueue(operation, key);
}

function logTripStateTransition(source, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  log(
    `trip state source=${source}`
    + ` phase=${before.phase}->${after.phase}`
    + ` segments=${before.segment_count}->${after.segment_count}`
    + ` pending=${before.pending_count}->${after.pending_count}`
    + ` active=${before.active}->${after.active}`
    + ` boundary=${before.boundary_stage}->${after.boundary_stage}`
    + ` reason=${after.reason}`
  );
}

async function persistTripMutation(operation, source = "mutation") {
  if (!tripTracker) return false;
  const beforeState = tripTracker.toJSON();
  const before = JSON.stringify(beforeState);
  const changed = operation();
  if (changed || JSON.stringify(tripTracker.toJSON()) !== before) {
    await saveTripMonitorState(tripTracker.toJSON());
    logTripStateTransition(
      source,
      summarizeTripState(beforeState),
      summarizeTripState(tripTracker.toJSON())
    );
    return true;
  }
  return false;
}

async function observeTripChargingEvents(events, observedAt) {
  if (!events.some((event) => event.type === "started")) return false;
  return enqueueTrip(() => persistTripMutation(
    () => tripTracker?.observeChargingStarted(observedAt),
    "charging"
  ));
}

async function startTripMonitor() {
  const state = await getRuntimeState();
  tripTracker = new TripSessionTracker(state.trip_monitor);
  const runTripDatabaseCheck = createTripDatabaseMonitor({
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
  checkTripDatabase = async () => {
    const before = summarizeTripState(tripTracker.toJSON());
    const result = await runTripDatabaseCheck();
    tripLastSuccess = Date.now();
    logTripStateTransition(before.phase === "idle" ? "startup_db" : "database", before, summarizeTripState(tripTracker.toJSON()));
    return result;
  };
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
  const runChargingCheck = checkChargingDatabase;
  checkChargingDatabase = async () => {
    const result = await runChargingCheck();
    chargingLastSuccess = Date.now();
    return result;
  };
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
    if (stopping) return;
    const observedAt = new Date().toISOString();
    const tripSignal = parseVehicleSignalTopic(topic, payload.toString("utf8"));
    if (tripSignal) {
      // Persist independently of the database/Feishu queue so a blocked send
      // cannot prevent a short-lived edge from reaching durable storage.
      signalWrites.enqueue(() => appendTripSignal({
        id: randomUUID(), ...tripSignal, at: observedAt, retained: Boolean(packet?.retain)
      })).then(() => checkTripDatabase && enqueueTrip(checkTripDatabase, 'database'))
        .catch((error) => log(`trip signal check failed code=${safeErrorCode(error)}`));
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
  const schedule = () => schedulerQueue.enqueue(checkScheduledPush, 'scheduled')
    .catch((error) => log(`scheduler failed code=${safeErrorCode(error)}`));
  schedule();
  every(schedule, 60_000);
  every(() => {
    if (!checkChargingDatabase) return;
    chargingQueue.enqueue(checkChargingDatabase, 'database')
      .catch((error) => log(`charging database check failed: ${error.message}`));
  }, 60_000);
  every(() => {
    if (!checkTripDatabase) return;
    enqueueTrip(checkTripDatabase, 'database')
      .catch((error) => log(`trip database check failed: ${error.message}`));
  }, tripBoundaryDefaults.pollMs);
  every(() => refreshReferenceFuelPrices().catch((error) => log(`fuel reference refresh failed code=${safeErrorCode(error)}`)), 6 * 60 * 60 * 1_000);
  every(reportHealth, 60_000);
  const repairMaps = () => mapRepairQueue.enqueue(retryPendingMapCards, 'map_repair')
    .catch(error => log(`map_card_repair status=failed code=${safeErrorCode(error)}`));
  repairMaps();
  every(repairMaps, 15_000);
}

let tripLastSuccess = null;
let chargingLastSuccess = null;

function every(operation, ms) {
  const timer = setInterval(() => { if (!stopping) operation(); }, ms);
  timer.unref();
  timers.add(timer);
}

async function reportHealth() {
  try {
    const state = await getRuntimeState();
    const pending = state.trip_signal_inbox || [];
    log(`monitor_health consumers=${children.size} mqtt=${Boolean(mqttClient?.connected)}`
      + ` handlers=${processEvent.size}`
      + ` trip_queue=${tripQueue.size} charging_queue=${chargingQueue.size}`
      + ` signal_pending=${pending.length}`
      + ` signal_age_ms=${pending.length ? Math.max(0, Date.now() - Date.parse(pending[0].at)) : 0}`
      + ` trip_success_age_ms=${tripLastSuccess ? Date.now() - tripLastSuccess : -1}`
      + ` charging_success_age_ms=${chargingLastSuccess ? Date.now() - chargingLastSuccess : -1}`);
  } catch (error) { log(`monitor_health failed code=${safeErrorCode(error)}`); }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`worker stopping signal=${signal}`);
  for (const timer of timers) clearInterval(timer);
  for (const child of children) child.kill("SIGTERM");
  mqttClient?.end(true);
  const deadline = setTimeout(() => process.exit(0), 15_000);
  await signalWrites.drain();
  await Promise.all([tripQueue.drain(), chargingQueue.drain(), schedulerQueue.drain(), mapRepairQueue.drain(), processEvent.drain()]);
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => log(`uncaught exception: ${error.message}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.message || error}`));

await boot();
