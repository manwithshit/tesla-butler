import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('signal inbox and tracker commit atomically without removing concurrently appended signals or unrelated state', async () => {
  const base = path.resolve('data/processed');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'signal-store-test-'));
  try {
    const script = `import {appendTripSignal, saveTripMonitorState, getRuntimeState, markScheduledPush} from './src/store.mjs';
      await markScheduledPush('fixture-period');
      const event = {id:'first',field:'locked',value:false,at:'2026-09-06T01:00:00Z',retained:true};
      await appendTripSignal(event); await appendTripSignal(event);
      await Promise.all([saveTripMonitorState({initialized:true}, {signalIds:['first']}),appendTripSignal({...event,id:'second'})]);
      const state=await getRuntimeState(); console.log(JSON.stringify({ids:state.trip_signal_inbox.map(s=>s.id),initialized:state.trip_monitor.initialized,sent:Boolean(state.sent['fixture-period'])}));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, TICKET_PROJECT_ROOT: root }
    });
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), {ids:['second'], initialized:true, sent:true});
    const mode = (await fs.stat(path.join(root, 'data/processed/runtime-state.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

test('received signal evidence survives inbox consumption and never copies private source fields', async () => {
  const root = await fs.mkdtemp(path.join(path.resolve('data/processed'), 'trip-receipt-audit-test-'));
  try {
    const script = `import {appendTripSignal,saveTripMonitorState,getRuntimeState} from './src/store.mjs';
      const event={id:'fixture',field:'locked',value:true,at:new Date().toISOString(),retained:false,car_id:'PRIVATE',lat:0,token:'PRIVATE'};
      await appendTripSignal(event); await appendTripSignal(event);
      await saveTripMonitorState({initialized:true},{signalIds:['fixture']});
      const state=await getRuntimeState(); console.log(JSON.stringify({inbox:state.trip_signal_inbox,receipts:state.trip_signal_receipts}));`;
    const child = spawnSync(process.execPath, ['--input-type=module','-e',script], {encoding:'utf8',env:{...process.env,TICKET_PROJECT_ROOT:root}});
    assert.equal(child.status,0);
    const result=JSON.parse(child.stdout);
    assert.equal(result.inbox.length,0); assert.equal(result.receipts.length,1);
    assert.equal(result.receipts[0].event,'received'); assert.equal(result.receipts[0].value,true);
    assert.doesNotMatch(child.stdout,/PRIVATE|car_id|lat|token/);
    assert.equal((await fs.stat(path.join(root,'data/processed/runtime-state.json'))).mode & 0o777,0o600);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('map repair tasks persist privately across restarts and do not overwrite concurrent state', async () => {
  const base = path.resolve('data/processed');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'map-repair-store-test-'));
  const run = script => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, TICKET_PROJECT_ROOT: root }
  });
  try {
    const first = run(`import {setMapCardRepair,updateMapCardRepair,markScheduledPush} from './src/store.mjs';
      await setMapCardRepair('first',{attempts:0});
      await Promise.all([updateMapCardRepair('first',{attempts:1}),setMapCardRepair('second',{attempts:0}),markScheduledPush('fixture')]);
      await setMapCardRepair('first',{attempts:0});`);
    assert.equal(first.status, 0);
    const second = run(`import {getRuntimeState,updateMapCardRepair} from './src/store.mjs';
      const before = await getRuntimeState();
      await updateMapCardRepair('first',null);
      const after = await getRuntimeState();
      console.log(JSON.stringify({attempt:before.map_card_repairs.first.attempts,count:Object.keys(after.map_card_repairs).length,sent:Boolean(after.sent.fixture)}));`);
    assert.equal(second.status, 0);
    assert.deepEqual(JSON.parse(second.stdout), {attempt:1,count:1,sent:true});
    assert.equal((await fs.stat(path.join(root, 'data/processed/runtime-state.json'))).mode & 0o777, 0o600);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
