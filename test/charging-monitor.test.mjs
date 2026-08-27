import test from "node:test";
import assert from "node:assert/strict";
import { ChargingTracker } from "../src/charging.mjs";
import { createChargingDatabaseMonitor, deliverPendingChargingEvents } from "../src/charging-monitor.mjs";

test("an MQTT charging start stays pending until the current session battery arrives", async () => {
  const sent = [];
  const tracker = new ChargingTracker();
  tracker.update("1", "battery_level", 97, "2026-08-25T00:59:59Z");
  tracker.update("1", "charging_state", "Charging", "2026-08-25T01:00:00Z");
  const dependencies = {
    tracker,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async () => {},
    sendEvent: async (_chatId, event) => sent.push(event)
  };

  const waiting = await deliverPendingChargingEvents({
    ...dependencies,
    at: "2026-08-25T01:00:01Z"
  });
  assert.equal(waiting.status, "waiting");
  assert.equal(tracker.pendingEvents().length, 1);
  assert.equal(sent.length, 0);

  tracker.update("1", "battery_level", 41, "2026-08-25T01:00:02Z");
  const delivered = await deliverPendingChargingEvents({
    ...dependencies,
    at: "2026-08-25T01:00:03Z"
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(sent[0].snapshot.battery_level, 41);
  assert.equal(tracker.pendingEvents().length, 0);
});

test("database monitor delivers a missed charging start once", async () => {
  const sent = [];
  const saved = [];
  const tracker = new ChargingTracker();
  const check = createChargingDatabaseMonitor({
    tracker,
    getLatestProcess: async () => ({
      id: 12,
      car_id: 1,
      start_at: "2026-08-25T06:35:49Z",
      end_at: null,
      start_battery_level: 64,
      latest_battery_level: 70,
      latest_charger_power: 48,
      latest_charge_energy_added: 3.2
    }),
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => saved.push(state),
    sendEvent: async (_chatId, event) => sent.push(event),
    now: () => new Date("2026-08-25T06:36:30Z")
  });

  assert.equal((await check()).status, "delivered");
  assert.deepEqual(sent.map((event) => event.type), ["started"]);
  assert.deepEqual(saved.at(-1).pending_events, {});
  assert.equal((await check()).status, "unchanged");
  assert.equal(sent.length, 1);
});

test("database monitor reports a new charging start once to its boundary callback", async () => {
  const observed = [];
  const tracker = new ChargingTracker();
  const check = createChargingDatabaseMonitor({
    tracker,
    getLatestProcess: async () => ({
      id: 112,
      car_id: 1,
      start_at: "2026-08-26T06:35:49Z",
      end_at: null,
      start_battery_level: 64,
      latest_battery_level: 70
    }),
    getRuntimeState: async () => ({}),
    saveState: async () => {},
    sendEvent: async () => {},
    onEvents: async (events) => observed.push(...events),
    now: () => new Date("2026-08-26T06:36:30Z")
  });

  await check();
  await check();
  assert.deepEqual(observed.map((event) => event.type), ["started"]);
});

test("database monitor never overlaps a slow check", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const check = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(),
    getLatestProcess: async () => {
      calls += 1;
      return gate;
    },
    getRuntimeState: async () => ({}),
    saveState: async () => {},
    sendEvent: async () => {}
  });

  const first = check();
  const second = check();
  release(null);
  assert.equal((await second).status, "busy");
  assert.equal((await first).status, "empty");
  assert.equal(calls, 1);
});

test("database monitor times out and releases the next check", async () => {
  let calls = 0;
  const check = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(),
    getLatestProcess: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    getRuntimeState: async () => ({}),
    saveState: async () => {},
    sendEvent: async () => {},
    timeoutMs: 10
  });

  await assert.rejects(check(), /timed out/i);
  await assert.rejects(check(), /timed out/i);
  assert.equal(calls, 2);
});

test("a failed Feishu charging notification remains pending and retries on the next check", async () => {
  let attempts = 0;
  const tracker = new ChargingTracker();
  const check = createChargingDatabaseMonitor({
    tracker,
    getLatestProcess: async () => ({
      id: 14,
      car_id: 1,
      start_at: "2026-08-25T08:00:00Z",
      end_at: null,
      start_battery_level: 40,
      latest_battery_level: 42
    }),
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async () => {},
    sendEvent: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary Feishu failure");
    },
    now: () => new Date("2026-08-25T08:00:30Z")
  });

  await assert.rejects(check(), /temporary Feishu failure/);
  assert.equal((await check()).status, "delivered");
  assert.equal(attempts, 2);
});

test("a pending notification survives a Worker restart", async () => {
  let persisted = null;
  const activeProcess = {
    id: 17,
    car_id: 1,
    start_at: "2026-08-25T11:00:00Z",
    end_at: null,
    start_battery_level: 30,
    latest_battery_level: 31
  };
  const firstCheck = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(),
    getLatestProcess: async () => activeProcess,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => { persisted = structuredClone(state); },
    sendEvent: async () => { throw new Error("Worker stopped during send"); },
    now: () => new Date("2026-08-25T11:00:30Z")
  });

  await assert.rejects(firstCheck(), /Worker stopped during send/);
  assert.equal(Object.keys(persisted.pending_events).length, 1);

  const sent = [];
  const restartedCheck = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(persisted),
    getLatestProcess: async () => activeProcess,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async (state) => { persisted = structuredClone(state); },
    sendEvent: async (_chatId, event) => sent.push(event.type),
    now: () => new Date("2026-08-25T11:01:00Z")
  });

  assert.equal((await restartedCheck()).status, "delivered");
  assert.deepEqual(sent, ["started"]);
  assert.deepEqual(persisted.pending_events, {});
});

test("a notification waits until a Feishu chat has been registered", async () => {
  let chatId = null;
  let persisted = null;
  const sent = [];
  const check = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(),
    getLatestProcess: async () => ({
      id: 18,
      car_id: 1,
      start_at: "2026-08-25T12:00:00Z",
      end_at: null,
      start_battery_level: 50,
      latest_battery_level: 52
    }),
    getRuntimeState: async () => ({ chat_id: chatId }),
    saveState: async (state) => { persisted = structuredClone(state); },
    sendEvent: async (_registeredChat, event) => sent.push(event.type),
    now: () => new Date("2026-08-25T12:00:30Z")
  });

  assert.equal((await check()).status, "no_chat");
  assert.equal(Object.keys(persisted.pending_events).length, 1);
  chatId = "chat";
  assert.equal((await check()).status, "delivered");
  assert.deepEqual(sent, ["started"]);
});

test("a stale pending start is discarded when the database already shows completion", async () => {
  let process = {
    id: 15,
    car_id: 1,
    start_at: "2026-08-25T09:00:00Z",
    end_at: null,
    start_battery_level: 50,
    latest_battery_level: 55
  };
  let failFirst = true;
  const sent = [];
  const check = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(),
    getLatestProcess: async () => process,
    getRuntimeState: async () => ({ chat_id: "chat" }),
    saveState: async () => {},
    sendEvent: async (_chatId, event) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("temporary Feishu failure");
      }
      sent.push(event.type);
    },
    now: () => new Date("2026-08-25T09:01:00Z")
  });

  await assert.rejects(check(), /temporary Feishu failure/);
  process = {
    ...process,
    end_at: "2026-08-25T09:00:50Z",
    end_battery_level: 56,
    charge_energy_added: 2.1,
    duration_min: 1
  };
  assert.equal((await check()).status, "delivered");
  assert.deepEqual(sent, ["completed"]);
});
