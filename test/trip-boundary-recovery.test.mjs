import test from 'node:test';
import assert from 'node:assert/strict';
import { TripSessionTracker, tripBoundaryDefaults } from '../src/trip-session.mjs';
import { createTripDatabaseMonitor } from '../src/trip-monitor.mjs';

const at = time => `2026-09-16T${time}Z`;
const first = { id: 1, start_at: at('00:23:11'), end_at: at('01:23:40') };
const temporary = { id: 2, start_at: at('01:24:03') };
function beforeDisappearance() {
  const tracker = new TripSessionTracker({ initialized: true });
  tracker.reconcile({ completed: [first], active: null }, at('01:23:41'));
  tracker.observeVehicleSignal('locked', false, at('01:23:41'), { retained: true });
  tracker.observeVehicleSignal('driver_front_door_open', false, at('01:23:41'), { retained: true });
  tracker.reconcile({ completed: [first], active: temporary }, at('01:24:04'));
  return tracker;
}

test('September 16 morning: two absent DB polls release a vanished short drive and lock ends only the first journey', () => {
  const tracker = beforeDisappearance();
  tracker.reconcile({ completed: [first], active: null }, at('01:24:15'));
  assert.equal(tracker.toJSON().session.phase, 'driving');
  tracker.reconcile({ completed: [first], active: null }, at('01:24:30'));
  assert.equal(tracker.toJSON().session.phase, 'parked');
  assert.equal(tracker.toJSON().session.active_started_at, null);
  tracker.observeVehicleSignal('driver_front_door_open', true, at('01:27:15'));
  tracker.observeVehicleSignal('driver_front_door_open', false, at('01:27:29'));
  tracker.observeVehicleSignal('locked', true, at('01:27:59'));
  tracker.reconcile({ completed: [first], active: null }, at('01:28:44'));
  assert.deepEqual(tracker.pendingEvents().map(e => e.segment_ids), [[1]]);
  tracker.acknowledge(tracker.pendingEvents()[0], at('01:28:45'));
  tracker.reconcile({ completed: [first], active: { id: 3, start_at: at('01:49:16') } }, at('01:49:17'));
  assert.deepEqual(tracker.toJSON().session.segment_ids, []);
  assert.equal(tripBoundaryDefaults.inactivityTimeoutMs, 30 * 60_000);
});

test('single absence, repeated replay, returning active drive and an empty temporary session never manufacture a journey', () => {
  const tracker = beforeDisappearance();
  tracker.reconcile({ completed: [first], active: null }, at('01:24:15'));
  tracker.reconcile({ completed: [first], active: null }, at('01:24:16'));
  tracker.reconcile({ completed: [first], active: null }, at('01:25:00'), { historical: true });
  assert.equal(tracker.toJSON().session.phase, 'driving');
  tracker.reconcile({ completed: [first], active: temporary }, at('01:25:01'));
  tracker.reconcile({ completed: [first], active: null }, at('01:25:20'));
  assert.equal(tracker.toJSON().session.phase, 'driving');
  const restarted = new TripSessionTracker(tracker.toJSON());
  restarted.reconcile({ completed: [first], active: null }, at('01:25:35'));
  assert.equal(restarted.toJSON().session.phase, 'parked');
  const empty = new TripSessionTracker({ initialized: true });
  empty.reconcile({ completed: [], active: temporary }, at('01:24:04'));
  empty.reconcile({ completed: [], active: null }, at('01:24:15'));
  empty.reconcile({ completed: [], active: null }, at('01:24:30'));
  assert.equal(empty.toJSON().session, null);
  assert.deepEqual(empty.pendingEvents(), []);
});

test('in-motion, retained, cancelled and expired lock candidates cannot end a trip', () => {
  for (const scenario of ['motion', 'retained', 'cancelled', 'expired']) {
    const tracker = new TripSessionTracker({ initialized: true });
    tracker.reconcile({ completed: [], active: { id: 1, start_at: at('00:23:11') } }, at('00:23:11'));
    tracker.observeVehicleSignal('locked', false, at('00:23:12'), { retained: true });
    tracker.observeVehicleSignal('locked', true, at(scenario === 'motion' ? '00:24:00' : '01:23:45'), { retained: scenario === 'retained' });
    if (scenario === 'cancelled') tracker.observeVehicleSignal('locked', false, at('01:23:46'));
    tracker.reconcile({ completed: [first], active: null }, at(scenario === 'expired' ? '01:34:00' : '01:25:00'));
    assert.equal(tracker.toJSON().session.phase, 'parked', scenario);
    assert.equal(tracker.pendingEvents().length, 0, scenario);
  }
});

test('September 16 evening without lock evidence still merges after 28m52s and retains the 30 minute rule', () => {
  const tracker = new TripSessionTracker({ initialized: true });
  const moved = { id: 6, start_at: at('10:33:09'), end_at: at('10:36:02') };
  tracker.reconcile({ completed: [moved], active: null }, at('10:36:03'));
  tracker.reconcile({ completed: [moved], active: { id: 7, start_at: at('11:04:54') } }, at('11:04:55'));
  assert.equal(tracker.pendingEvents().length, 0);
  tracker.reconcile({ completed: [moved, { id: 7, start_at: at('11:04:54'), end_at: at('11:33:53') }], active: null }, at('11:33:54'));
  assert.deepEqual(tracker.toJSON().session.segment_ids, [6, 7]);
});

test('a fresh lock alone received before delayed DB completion is reconsidered after restart', () => {
  const tracker = new TripSessionTracker({ initialized: true });
  tracker.reconcile({ completed: [], active: { id: 1, start_at: at('00:23:11') } }, at('00:23:11'));
  tracker.observeVehicleSignal('locked', false, at('00:23:12'), { retained: true });
  tracker.observeVehicleSignal('locked', true, at('01:23:45'));
  assert.equal(tracker.pendingEvents().length, 0);
  const restored = new TripSessionTracker(tracker.toJSON());
  restored.reconcile({ completed: [first], active: null }, at('01:24:00'));
  assert.equal(restored.toJSON().session.finalization_reason, 'locked_parallel');
  assert.ok(restored.toJSON().audit.some(e => e.decision === 'deferred_lock_accepted'));
  restored.reconcile({ completed: [first], active: null }, at('01:24:30'));
  assert.deepEqual(restored.pendingEvents().map(e => e.segment_ids), [[1]]);
  restored.acknowledge(restored.pendingEvents()[0], at('01:24:31'));
  const again = new TripSessionTracker(restored.toJSON());
  again.reconcile({ completed: [first], active: null }, at('01:25:00'));
  assert.equal(again.pendingEvents().length, 0);
});

test('full door-lock evidence expires or is cancelled by a fresh unlock while DB completion is delayed', () => {
  for (const scenario of ['expired','unlocked']) {
    const tracker = new TripSessionTracker({initialized:true});
    tracker.reconcile({completed:[],active:{id:1,start_at:first.start_at}},at('00:23:11'));
    tracker.observeVehicleSignal('locked',false,at('00:23:12'),{retained:true});
    tracker.observeVehicleSignal('driver_front_door_open',false,at('00:23:12'),{retained:true});
    tracker.observeVehicleSignal('driver_front_door_open',true,at('01:23:41'));
    tracker.observeVehicleSignal('driver_front_door_open',false,at('01:23:42'));
    tracker.observeVehicleSignal('locked',true,at('01:23:45'));
    if(scenario==='unlocked')tracker.observeVehicleSignal('locked',false,at('01:23:46'));
    tracker.reconcile({completed:[first],active:null},at(scenario==='expired'?'01:34:00':'01:25:00'));
    assert.equal(tracker.toJSON().session.phase,'parked');
    assert.equal(tracker.pendingEvents().length,0);
  }
});

test('full monitor replays the morning timeline across restarts and sends two separate journeys exactly once', async () => {
  const state = { chat_id: 'fixture', trip_monitor: { initialized: true }, trip_signal_inbox: [] };
  const sent = [];
  let sequence = 0;
  async function poll(time, snapshot, values = []) {
    state.trip_signal_inbox.push(...values.map(([field,value,retained=false]) => ({id:String(++sequence),at:at(time),field,value,retained})));
    await createTripDatabaseMonitor({
      tracker: new TripSessionTracker(state.trip_monitor),
      getSnapshot: async () => snapshot,
      getRuntimeState: async () => structuredClone(state),
      getTrip: async ids => ({ segment_ids: ids }),
      saveState: async (next,{signalIds=[]}={}) => {
        state.trip_monitor=structuredClone(next);
        state.trip_signal_inbox=state.trip_signal_inbox.filter(s=>!signalIds.includes(s.id));
      },
      sendTrip: async (_chat,event) => sent.push(event.segment_ids), now: () => new Date(at(time))
    })();
  }
  const parked={completed:[first],active:null};
  await poll('01:23:41',parked,[['locked',false,true],['driver_front_door_open',false,true]]);
  await poll('01:24:04',{completed:[first],active:temporary});
  await poll('01:24:15',parked); await poll('01:24:30',parked);
  await poll('01:27:15',parked,[['driver_front_door_open',true]]);
  await poll('01:27:29',parked,[['driver_front_door_open',false]]);
  await poll('01:27:59',parked,[['locked',true]]);
  await poll('01:28:44',parked); await poll('01:28:59',parked);
  assert.deepEqual(sent,[[1]]);
  const second={id:3,start_at:at('01:49:16'),end_at:at('02:23:37')};
  await poll('01:49:16',{completed:[first],active:{id:3,start_at:second.start_at}},[['locked',false]]);
  await poll('01:49:30',{completed:[first],active:{id:3,start_at:second.start_at}},[['locked',true]]);
  const done={completed:[first,second],active:null};
  await poll('02:23:39',done,[['locked',false]]);
  await poll('02:23:54',done,[['driver_front_door_open',true]]);
  await poll('02:24:40',done,[['driver_front_door_open',false]]);
  await poll('02:26:42',done,[['locked',true]]);
  await poll('02:27:27',done); await poll('02:27:42',done);
  assert.deepEqual(sent,[[1],[3]]);
  assert.equal(state.trip_signal_inbox.length,0);
  assert.equal(Object.keys(state.trip_monitor.pending_events).length,0);
  assert.ok(state.trip_monitor.audit.some(e=>e.decision==='parked_recovered'));
});
