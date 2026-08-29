# Trip Session Lock Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-minute quiet-trip heuristic with a persistent PostgreSQL-backed trip session state machine finalized by driver-door/lock signals, charging, or a one-hour inactivity timeout.

**Architecture:** A pure `TripSessionTracker` owns state transitions and persistence-safe data. The existing database monitor hydrates pending segment IDs from PostgreSQL before sending, while Worker MQTT routing serializes retained-aware vehicle signals and charging boundaries through the trip queue. Existing card, Shanghai time, map retry/cache, charging, receipt, menu, and scheduler paths remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, MQTT.js, TeslaMate PostgreSQL through Docker Compose, launchd, lark-cli.

## 2026-08-27 production race follow-up

The first real multi-segment drive exposed two ordering races that the original plan did not model explicitly:

- A parked timeout was evaluated before a newly completed continuation was absorbed, so the earlier segment could be queued alone.
- Door/lock edges arriving while PostgreSQL still exposed the just-finished drive as active were discarded.

The corrective vertical slices are:

- [x] RED→GREEN: absorb a short-gap completed continuation before evaluating inactivity.
- [x] RED→GREEN: an active continuation suppresses the parked timeout, even after one hour of wall time.
- [x] RED→GREEN: persist a door-open/close/lock candidate during database lag and validate it against the completed segment end.
- [x] RED→GREEN: reject candidates that occurred materially before the database end and never synthesize candidates from retained messages.
- [x] RED→GREEN: restore a pending boundary candidate across Worker restart without duplicate delivery.
- [x] RED→GREEN: charging finalization waits for the currently active database segment to be absorbed.
- [x] Add aggregate-only trip state transition evidence to Worker logs.

## 2026-08-29 missed-door follow-up

- [x] RED→GREEN: a fresh lock can finalize only an existing parked, unsent session when the door edge was missed.
- [x] RED→GREEN: no session, active driving, retained values and late locks remain no-ops.
- [x] RED→GREEN: an active drive during the 45-second parallel confirmation cancels the boundary and keeps the session merged.
- [x] RED→GREEN: stale incomplete door candidates cannot block a valid parked lock fallback.
- [x] RED→GREEN: inactivity changes from 60 to 30 minutes and is anchored to PostgreSQL `parked_at`.
- [x] RED→GREEN: unrelated MQTT changes cannot postpone the timeout.

---

## File map

- Create `src/trip-session.mjs`: pure state machine, persisted schema, timeout/finalization constants.
- Create `src/vehicle-signals.mjs`: strict parsing and topic list for door/lock signals.
- Create `src/verify-trip-session-live.mjs`: read-only production-state dry run.
- Modify `src/trip-monitor.mjs`: database hydration, retry/ack orchestration, backward-compatible export.
- Modify `src/teslamate.mjs`: allow one-hour session aggregation for explicit segment IDs.
- Modify `src/charging-monitor.mjs`: expose newly observed charging events to the trip boundary callback.
- Modify `src/worker.mjs`: restore tracker before MQTT, subscribe signals, serialize persistence, use a 15-second trip poll.
- Modify `package.json`: add the live-safe verifier command.
- Create `test/trip-session.test.mjs` and `test/vehicle-signals.test.mjs`.
- Modify `test/trip-monitor.test.mjs` and `test/charging-monitor.test.mjs`.

### Task 1: Driving and retained baselines

**Files:**
- Create: `test/trip-session.test.mjs`
- Create: `src/trip-session.mjs`

- [ ] **Step 1: Write one failing driving/auto-lock test**

```js
test("driving starts a session and ignores automatic locking", () => {
  const tracker = initializedTracker();
  tracker.reconcile({ completed: [], active: activeDrive(10) }, at("10:00:00"));
  tracker.observeVehicleSignal("locked", false, at("10:00:01"), { retained: true });
  tracker.observeVehicleSignal("locked", true, at("10:00:02"));
  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.pendingEvents(), []);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/trip-session.test.mjs --test-name-pattern='driving starts'`

Expected: FAIL because `TripSessionTracker` does not exist.

- [ ] **Step 3: Implement the minimal public state**

```js
export const tripBoundaryDefaults = Object.freeze({
  finalizationDelayMs: 45_000,
  inactivityTimeoutMs: 60 * 60 * 1_000,
  pollMs: 15_000
});

export class TripSessionTracker {
  constructor(saved = {}) {
    this.state = normalizeTripState(saved);
  }

  reconcile(snapshot, at) {
    if (!this.state.initialized) {
      this.state.initialized = true;
      this.state.last_processed_drive_id = latestCompletedId(snapshot.completed);
    }
    if (snapshot.active && !this.state.session) {
      this.state.session = newSession("driving", at);
    }
    return this.pendingEvents();
  }

  observeVehicleSignal(field, value, at, { retained = false } = {}) {
    const signal = this.state.signals[field];
    if (!signal.initialized || retained) {
      signal.initialized = true;
      signal.value = value;
      return true;
    }
    signal.value = value;
    return true;
  }

  pendingEvents() {
    return structuredClone(Object.values(this.state.pending_events));
  }

  toJSON() {
    return structuredClone(this.state);
  }
}
```

- [ ] **Step 4: Run GREEN**

Run: `node --test test/trip-session.test.mjs`

Expected: PASS for the first behavior.

- [ ] **Step 5: Add retained-start RED then GREEN**

```js
test("retained locked true only initializes baseline", () => {
  const tracker = parkedTracker();
  tracker.observeVehicleSignal("locked", true, at("10:20:01"), { retained: true });
  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.deepEqual(tracker.pendingEvents(), []);
});
```

Run RED, minimally implement retained suppression, then run GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/trip-session.mjs test/trip-session.test.mjs
git commit -m "feat: start persistent trip sessions"
```

### Task 2: Door-close-lock finalization

**Files:**
- Modify: `test/trip-session.test.mjs`
- Modify: `src/trip-session.mjs`

- [ ] **Step 1: Add RED for the complete door sequence**

```js
test("parked door open close and new lock finalizes exactly once", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));
  assert.equal(tracker.toJSON().session.phase, "finalizing");
  tracker.reconcile(completedSnapshot(), at("10:20:48"));
  assert.equal(tracker.pendingEvents().length, 1);
  tracker.reconcile(completedSnapshot(), at("10:21:03"));
  assert.equal(tracker.pendingEvents().length, 1);
});
```

- [ ] **Step 2: Run RED and verify the missing transition**

Run: `node --test test/trip-session.test.mjs --test-name-pattern='door open close'`

- [ ] **Step 3: Implement the minimal phase transitions**

```js
if (phase === "parked" && doorEdge === "open") phase = "door_open";
if (phase === "door_open" && doorEdge === "close") phase = "door_closed";
if (phase === "door_closed" && lockEdge === "lock") beginFinalizing("locked", at, 45_000);
```

- [ ] **Step 4: Run GREEN**

Run: `node --test test/trip-session.test.mjs`

- [ ] **Step 5: Add separate RED→GREEN tests for incomplete evidence**

```js
test("a lock without the door sequence does not finalize", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("locked", true, at("10:20:03"));
  assert.equal(tracker.toJSON().session.phase, "parked");
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a door sequence without a new lock does not finalize", () => {
  const tracker = parkedTracker();
  baselineUnlockedAndDoorClosed(tracker);
  tracker.observeVehicleSignal("driver_front_door_open", true, at("10:20:01"));
  tracker.observeVehicleSignal("driver_front_door_open", false, at("10:20:02"));
  assert.equal(tracker.toJSON().session.phase, "door_closed");
  assert.deepEqual(tracker.pendingEvents(), []);
});
```

Run each test alone to observe RED before adding its minimal guard, then run the file GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/trip-session.mjs test/trip-session.test.mjs
git commit -m "feat: finalize trips after door and lock"
```

### Task 3: Resume, timeout, and charging boundaries

**Files:**
- Modify: `test/trip-session.test.mjs`
- Modify: `src/trip-session.mjs`

- [ ] **Step 1: RED→GREEN for unlocked resume**

```js
test("an unlocked stop followed by driving within one hour stays one session", () => {
  const tracker = parkedTracker();
  tracker.reconcile(snapshotWithActiveNextSegment(), at("10:50:00"));
  assert.equal(tracker.toJSON().session.phase, "driving");
  assert.deepEqual(tracker.toJSON().session.segment_ids, [9]);
});
```

Run RED, implement only the parked-to-driving resume, and run GREEN.

- [ ] **Step 2: RED→GREEN for one-hour inactivity**

```js
test("one hour without activity queues the parked trip", () => {
  const tracker = parkedTracker();
  tracker.reconcile(completedSnapshot(), at("11:20:00"));
  assert.equal(tracker.pendingEvents().length, 1);
});
```

Run RED, implement the strict `elapsed >= inactivityTimeoutMs` boundary, and run GREEN.

- [ ] **Step 3: RED→GREEN for charging**

```js
test("charging start is a strong finalization boundary", () => {
  const tracker = parkedTracker();
  tracker.observeChargingStarted(at("10:25:00"));
  assert.equal(tracker.toJSON().session.phase, "finalizing");
});
```

Run RED, add `observeChargingStarted`, then run GREEN.

- [ ] **Step 4: Commit**

```bash
git add src/trip-session.mjs test/trip-session.test.mjs
git commit -m "feat: add trip timeout and charging boundaries"
```

### Task 4: Persistence, hydration, and delivery retries

**Files:**
- Modify: `test/trip-session.test.mjs`
- Modify: `test/trip-monitor.test.mjs`
- Modify: `src/trip-monitor.mjs`
- Modify: `src/teslamate.mjs`

- [ ] **Step 1: RED→GREEN restart recovery**

```js
test("a persisted parked session resumes without replaying old drives", () => {
  const restored = new TripSessionTracker(structuredClone(original.toJSON()));
  restored.reconcile(sameSnapshot, nextMinute);
  assert.deepEqual(restored.pendingEvents(), []);
  assert.deepEqual(restored.toJSON().session.segment_ids, original.toJSON().session.segment_ids);
});
```

- [ ] **Step 2: RED→GREEN failed-send persistence**

Add a database monitor test where `pending_events` contains only segment IDs, `getTrip(segmentIds)` returns a safe hydrated trip, and the first `sendTrip` throws. Assert the pending key remains and no sent key is written. Recreate the tracker from `toJSON()`, rerun with a successful sender, and assert exactly one send, no pending key, and exactly one sent key.

Run: `node --test test/trip-monitor.test.mjs --test-name-pattern='failed trip push'`

Expected RED: existing delivery expects `event.trip` inside persisted state.

Minimal monitor API:

```js
createTripDatabaseMonitor({
  tracker,
  getSnapshot,
  getTrip,
  getRuntimeState,
  saveState,
  sendTrip,
  now
});
```

- [ ] **Step 3: Allow explicit one-hour session aggregation**

```js
export async function getDriveGroup(driveIds, options = {}) {
  const groups = groupDriveSegments(segments, options);
  if (groups.length !== 1) throw new Error("drive segments do not form one trip");
  return groups[0];
}
```

The automatic monitor passes `pauseMs: 60 * 60 * 1_000` and `endpointMeters: 100`; existing callers retain defaults.

- [ ] **Step 4: Run GREEN and regression tests**

Run: `node --test test/trip-session.test.mjs test/trip-monitor.test.mjs test/trip-sessions.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/trip-monitor.mjs src/teslamate.mjs test/trip-session.test.mjs test/trip-monitor.test.mjs
git commit -m "feat: persist and retry trip session delivery"
```

### Task 5: MQTT signal parsing and Worker integration

**Files:**
- Create: `test/vehicle-signals.test.mjs`
- Create: `src/vehicle-signals.mjs`
- Modify: `test/charging-monitor.test.mjs`
- Modify: `src/charging-monitor.mjs`
- Modify: `src/worker.mjs`

- [ ] **Step 1: RED→GREEN strict signal parsing**

```js
test("only door and lock boolean topics become trip signals", () => {
  assert.deepEqual(parseVehicleSignalTopic(validLockedTopic, "true"), { field: "locked", value: true });
  assert.equal(parseVehicleSignalTopic(validDoorTopic, "false").value, false);
  assert.equal(parseVehicleSignalTopic(validDoorTopic, "unknown"), null);
  assert.equal(parseVehicleSignalTopic(unrelatedTopic, "true"), null);
});
```

Run RED, implement `tripSignalFields`, `tripSignalTopics`, and `parseVehicleSignalTopic`, then run GREEN.

- [ ] **Step 2: RED→GREEN charging database callback**

```js
test("database monitor reports a new charging start once", async () => {
  const observed = [];
  const monitor = createChargingDatabaseMonitor({
    tracker: new ChargingTracker(initializedChargingState()),
    getSnapshot: async () => activeChargingSnapshot(),
    getRuntimeState: async () => runtimeStateWithChat(),
    saveState: async () => {},
    sendEvent: async () => {},
    onEvents: async (events) => observed.push(...events)
  });
  await monitor.check();
  await monitor.check();
  assert.deepEqual(observed.map((event) => event.type), ["started"]);
});
```

Run it RED, add the optional callback immediately after reconciliation and before delivery, then run GREEN.

- [ ] **Step 3: Integrate Worker queues minimally**

```js
const topics = [...chargingTopics, ...tripSignalTopics];

if (tripSignal) {
  enqueueTrip(async () => {
    const changed = tripTracker.observeVehicleSignal(
      tripSignal.field,
      tripSignal.value,
      observedAt,
      { retained: Boolean(packet?.retain) }
    );
    if (changed) await saveTripMonitorState(tripTracker.toJSON());
  }).catch((error) => log(`trip signal check failed: ${error.message}`));
}
```

Promote the tracker to Worker state, initialize trip monitoring before MQTT subscription, route charging `started` events into `observeChargingStarted`, keep the existing charging path unchanged, and poll trip DB every 15 seconds.

- [ ] **Step 4: Run focused and full GREEN**

Run: `node --check src/worker.mjs`

Run: `node --test test/vehicle-signals.test.mjs test/charging-monitor.test.mjs test/charging.test.mjs test/trip-session.test.mjs test/trip-monitor.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/vehicle-signals.mjs src/charging-monitor.mjs src/worker.mjs test/vehicle-signals.test.mjs test/charging-monitor.test.mjs
git commit -m "feat: connect door and lock MQTT trip signals"
```

### Task 6: Live-safe verifier and complete regressions

**Files:**
- Create: `src/verify-trip-session-live.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the read-only verifier**

```js
const state = await getRuntimeState();
const before = JSON.stringify(state.trip_monitor || {});
const tracker = new TripSessionTracker(state.trip_monitor);
tracker.reconcile(await getDriveMonitorSnapshot(), new Date().toISOString());
const dryRun = tracker.toJSON();
process.stdout.write(JSON.stringify({
  ok: true,
  initialized: dryRun.initialized,
  active_session: Boolean(dryRun.session),
  pending_events: Object.keys(dryRun.pending_events).length,
  would_finalize: tracker.pendingEvents().length > Object.keys(state.trip_monitor?.pending_events || {}).length,
  persisted_state_unchanged: before === JSON.stringify(state.trip_monitor || {})
}) + "\n");
```

Add `"test:trip-session-live": "node src/verify-trip-session-live.mjs"`.

- [ ] **Step 2: Run static and regression checks**

Run:

```bash
node --check src/trip-session.mjs
node --check src/vehicle-signals.mjs
node --check src/trip-monitor.mjs
node --check src/charging-monitor.mjs
node --check src/worker.mjs
node --check src/verify-trip-session-live.mjs
npm test
git diff --check
```

Expected: all tests pass, no syntax errors, no whitespace errors.

- [ ] **Step 3: Verify protected regressions explicitly**

Run:

```bash
node --test test/cards.test.mjs test/charging.test.mjs test/charging-monitor.test.mjs test/store.test.mjs test/schedule.test.mjs test/route-image.test.mjs test/messages.test.mjs
```

Expected: Shanghai time, charging, receipts, weekly/monthly cards, menu behavior, map retry/cache, and user-visible map failure all pass.

- [ ] **Step 4: Scan staged changes for sensitive literals**

Run a staged-file-only scan for credential keys, vehicle identifiers, coordinates, addresses, and message identifiers. Inspect matches as code identifiers only; no secret values may exist.

- [ ] **Step 5: Commit**

```bash
git add package.json src/verify-trip-session-live.mjs
git commit -m "test: add live-safe trip session verification"
```

### Task 7: Integrate, deploy, observe, and push from M1

**Files:**
- Merge the verified branch into `/Users/earonwong/Developer/tesla-saving-ticket` main.
- Do not modify runtime data except through the deployed Worker's normal state persistence.

- [ ] **Step 1: Finish the development branch**

Use `finishing-a-development-branch`: rerun `npm test`, verify named linked worktree, verify base `main`, and use the user's pre-authorized local merge workflow.

- [ ] **Step 2: Revalidate main and merge safely**

```bash
git -C /Users/earonwong/Developer/tesla-saving-ticket status --short
git -C /Users/earonwong/Developer/tesla-saving-ticket fetch origin main
git -C /Users/earonwong/Developer/tesla-saving-ticket merge --ff-only codex/trip-lock-boundary
```

Stop if main is dirty, origin diverged, or fast-forward is impossible.

- [ ] **Step 3: Verify merged main before deployment**

Run syntax checks, `npm test`, `npm run test:live`, `npm run test:charging-live`, `npm run test:trip-live`, and `npm run test:trip-session-live`. Do not restart on failure.

- [ ] **Step 4: Restart only the existing Worker**

Use `launchctl kickstart -k` for the existing LaunchAgent. Do not restart Docker, rebuild the database, reset TeslaMate, or touch M5.

- [ ] **Step 5: Observe one full polling cycle**

Verify four Docker services, database health, one Worker, two Feishu consumers, event bus, MQTT charging/trip subscription, charging DB ready, trip DB ready, and at least 60 seconds with no old-trip replay, duplicate send, pending loss, handler failure, consumer exit, uncaught exception, or unhandled rejection.

- [ ] **Step 6: Push only after deployment passes**

```bash
git -C /Users/earonwong/Developer/tesla-saving-ticket push origin main
git -C /Users/earonwong/Developer/tesla-saving-ticket fetch origin main
test "$(git -C /Users/earonwong/Developer/tesla-saving-ticket rev-parse HEAD)" = "$(git -C /Users/earonwong/Developer/tesla-saving-ticket rev-parse origin/main)"
```

If push fails, preserve the tested local commit and report that origin was not updated.
