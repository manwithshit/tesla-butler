import test from "node:test";
import assert from "node:assert/strict";
import { createTripDatabaseMonitor } from "../src/trip-monitor.mjs";
import { TripSessionTracker } from "../src/trip-session.mjs";

function drive(id, startAt = "2026-08-26T10:00:00Z", endAt = "2026-08-26T10:20:00Z") {
  return { id, start_at: startAt, end_at: endAt };
}

function pendingState() {
  return {
    initialized: true,
    last_processed_drive_id: 9,
    pending_events: {
      "trip-9": {
        type: "completed_trip",
        eventKey: "trip-9",
        tripId: "trip-9",
        segment_ids: [9],
        reason: "locked"
      }
    }
  };
}

function monitorOptions(overrides = {}) {
  return {
    getSnapshot: async () => ({ completed: [drive(9)], active: null }),
    getTrip: async (segmentIds) => ({
      segment_ids: [...segmentIds],
      start_at: "2026-08-26T10:00:00Z",
      end_at: "2026-08-26T10:20:00Z"
    }),
    getRuntimeState: async () => ({ chat_id: "registered-chat" }),
    saveState: async () => {},
    sendTrip: async () => {},
    now: () => new Date("2026-08-26T10:20:01Z"),
    ...overrides
  };
}

test('persisted door and lock signals survive database failure and restart, preserving the original boundary', async () => {
  let state = { chat_id: 'fixture', trip_monitor: { initialized: true, last_processed_drive_id: 8 },
    trip_signal_inbox: [
      ['locked', false, '10:20:00', true],
      ['driver_front_door_open', false, '10:20:00', true],
      ['driver_front_door_open', true, '10:20:01', false],
      ['driver_front_door_open', false, '10:20:02', false],
      ['locked', true, '10:20:03', false]
    ].map(([field, value, time, retained], id) => ({ id: String(id), field, value, at: `2026-08-26T${time}Z`, retained })) };
  const sent = [];
  const options = () => monitorOptions({
    tracker: new TripSessionTracker(state.trip_monitor),
    getRuntimeState: async () => structuredClone(state),
    saveState: async (next, { signalIds = [] } = {}) => {
      state.trip_monitor = structuredClone(next);
      state.trip_signal_inbox = state.trip_signal_inbox.filter(s => !signalIds.includes(s.id));
    },
    sendTrip: async (_chat, event) => sent.push(event),
    now: () => new Date('2026-08-26T10:21:00Z')
  });
  const fail = createTripDatabaseMonitor({ ...options(), getSnapshot: async () => { throw new Error('offline'); } });
  await assert.rejects(fail(), /offline/);
  assert.equal(state.trip_signal_inbox.length, 5);
  const recover = createTripDatabaseMonitor(options());
  await recover();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reason, 'locked');
  assert.deepEqual(sent[0].segment_ids, [9]);
  assert.equal(state.trip_signal_inbox.length, 0);
  await createTripDatabaseMonitor(options())();
  assert.equal(sent.length, 1);
});

test('recovered parked lock ends its journey even when the next drive already completed during the outage', async () => {
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  const sent = [];
  const signals = [
    { id: 'a', field: 'locked', value: false, at: '2026-08-26T10:20:00Z', retained: true },
    { id: 'b', field: 'locked', value: true, at: '2026-08-26T10:20:01Z', retained: false }
  ];
  await createTripDatabaseMonitor(monitorOptions({ tracker,
    getRuntimeState: async () => ({ chat_id: 'fixture', trip_signal_inbox: signals }),
    getSnapshot: async () => ({ completed: [drive(9), drive(10, '2026-08-26T10:25:00Z', '2026-08-26T10:30:00Z')], active: null }),
    now: () => new Date('2026-08-26T10:31:00Z'),
    sendTrip: async (_chat, event) => sent.push(event.segment_ids)
  }))();
  assert.deepEqual(sent, [[9]]);
  assert.deepEqual(tracker.toJSON().session.segment_ids, [10]);
});

test('a failed durable acknowledgement keeps the event retryable with the same delivery key', async () => {
  const tracker = new TripSessionTracker(pendingState());
  const keys = []; let fail = true;
  const check = createTripDatabaseMonitor(monitorOptions({ tracker,
    sendTrip: async (_chat, _event, key) => keys.push(key),
    saveState: async () => { if (fail) { fail = false; throw new Error('disk failure'); } }
  }));
  await assert.rejects(check(), /disk failure/);
  assert.equal(tracker.pendingEvents().length, 1);
  await check();
  assert.deepEqual(keys, ['trip-9', 'trip-9']);
  assert.equal(tracker.pendingEvents().length, 0);
});

test('recovered in-motion auto-lock and retained parked lock do not create a new boundary', async () => {
  for (const [at, retained] of [['2026-08-26T10:10:00Z', false], ['2026-08-26T10:20:01Z', true]]) {
    const tracker = new TripSessionTracker({initialized:true,last_processed_drive_id:8});
    const sent=[];
    const signals=[
      {id:'baseline',field:'locked',value:false,at:'2026-08-26T10:00:00Z',retained:true},
      {id:'edge',field:'locked',value:true,at,retained}
    ];
    await createTripDatabaseMonitor(monitorOptions({tracker,
      getRuntimeState:async()=>({chat_id:'fixture',trip_signal_inbox:signals}),
      now:()=>new Date('2026-08-26T10:21:00Z'),
      sendTrip:async (_chat,event)=>sent.push(event)
    }))();
    assert.equal(sent.length,0);
    assert.equal(tracker.toJSON().session.phase,'parked');
  }
});

test('a failed inbox commit rolls back in-memory changes before retry', async () => {
  const tracker=new TripSessionTracker({initialized:true,last_processed_drive_id:8});
  const original=tracker.toJSON(); let fail=true;
  const check=createTripDatabaseMonitor(monitorOptions({tracker, saveState:async()=>{
    if(fail){fail=false;throw new Error('disk failure');}
  }}));
  await assert.rejects(check(),/disk failure/);
  assert.deepEqual(tracker.toJSON(),original);
  await check();
  assert.deepEqual(tracker.toJSON().session.segment_ids,[9]);
});

test('garage payment followed by a long drive stays one journey when a delayed lock occurred in motion', async () => {
  const tracker = new TripSessionTracker({initialized:true,last_processed_drive_id:8});
  const sent=[];
  await createTripDatabaseMonitor(monitorOptions({ tracker,
    getRuntimeState:async()=>({chat_id:'fixture',trip_signal_inbox:[
      {id:'baseline',field:'locked',value:false,at:'2026-08-26T09:59:00Z',retained:true},
      {id:'auto',field:'locked',value:true,at:'2026-08-26T10:04:00Z',retained:false}
    ]}),
    getSnapshot:async()=>({completed:[drive(9,'2026-08-26T10:00:00Z','2026-08-26T10:01:00Z'),drive(10,'2026-08-26T10:03:00Z','2026-08-26T11:00:00Z')],active:null}),
    now:()=>new Date('2026-08-26T11:01:00Z'),sendTrip:async(_chat,event)=>sent.push(event)
  }))();
  assert.equal(sent.length,0);
  assert.deepEqual(tracker.toJSON().session.segment_ids,[9,10]);
});

test("the first database check establishes a baseline without replaying history", async () => {
  const sent = [];
  const tracker = new TripSessionTracker();
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    sendTrip: async (_chatId, event) => sent.push(event)
  }));

  assert.equal((await check()).status, "unchanged");
  assert.deepEqual(sent, []);
  assert.equal(tracker.toJSON().last_processed_drive_id, 9);
  assert.deepEqual(tracker.pendingEvents(), []);
});

test("a newly completed segment persists a parked session without early delivery", async () => {
  const saved = [];
  const tracker = new TripSessionTracker({ initialized: true, last_processed_drive_id: 8 });
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    saveState: async (state) => saved.push(structuredClone(state))
  }));

  assert.equal((await check()).status, "unchanged");
  assert.equal(saved.at(-1).session.phase, "parked");
  assert.deepEqual(saved.at(-1).session.segment_ids, [9]);
  assert.deepEqual(saved.at(-1).pending_events, {});
});

test("a pending session is hydrated, delivered, and acknowledged exactly once", async () => {
  const delivered = [];
  let saved = null;
  const tracker = new TripSessionTracker(pendingState());
  const check = createTripDatabaseMonitor(monitorOptions({
    tracker,
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => delivered.push(event.trip.segment_ids)
  }));

  assert.equal((await check()).status, "delivered");
  assert.equal((await check()).status, "unchanged");
  assert.deepEqual(delivered, [[9]]);
  assert.deepEqual(saved.pending_events, {});
  assert.deepEqual(Object.keys(saved.sent_keys), ["trip-9"]);
});

test("failed session delivery keeps segment-only pending and hydrates once per retry", async () => {
  let getTripCalls = 0;
  const getTrip = async (segmentIds) => {
    getTripCalls += 1;
    return { segment_ids: [...segmentIds], start_at: "2026-08-26T10:00:00Z", end_at: "2026-08-26T10:20:00Z" };
  };
  const tracker = new TripSessionTracker(pendingState());
  const failedCheck = createTripDatabaseMonitor(monitorOptions({
    tracker,
    getTrip,
    sendTrip: async () => { throw new Error("temporary Feishu failure"); }
  }));

  await assert.rejects(failedCheck(), /temporary Feishu failure/);
  assert.equal(getTripCalls, 1);
  assert.deepEqual(tracker.pendingEvents()[0].segment_ids, [9]);
  assert.equal(tracker.pendingEvents()[0].trip, undefined);

  const restored = new TripSessionTracker(tracker.toJSON());
  const delivered = [];
  let saved = null;
  const successfulCheck = createTripDatabaseMonitor(monitorOptions({
    tracker: restored,
    getTrip,
    saveState: async (state) => { saved = structuredClone(state); },
    sendTrip: async (_chatId, event) => delivered.push(event.trip.segment_ids)
  }));

  assert.equal((await successfulCheck()).status, "delivered");
  assert.deepEqual(delivered, [[9]]);
  assert.equal(getTripCalls, 2);
  assert.deepEqual(saved.pending_events, {});
  assert.deepEqual(Object.keys(saved.sent_keys), ["trip-9"]);
});
