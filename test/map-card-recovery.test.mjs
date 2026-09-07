import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLatestTripCard } from '../src/cards.mjs';
import { makeMapRepairJob, createMapRepairProcessor, trackMapCardDelivery, patchSentMapCard } from '../src/map-card-recovery.mjs';

test('degraded route has a small grey explanation immediately below the image only', () => {
  const trip = { distance_km: 2, duration_min: 5 };
  const card = buildLatestTripCard(trip, 'fixture-image', true, { hasBasemap: false });
  const index = card.body.elements.findIndex(item => item.tag === 'img');
  const note = card.body.elements[index + 1];
  assert.equal(note.tag, 'markdown');
  assert.equal(note.text_size, 'notation');
  assert.equal(note.content, "<font color='grey'>底图暂不可用，已保留真实轨迹</font>");
  for (const healthy of [buildLatestTripCard(trip, 'fixture-image', true, { hasBasemap: true }), buildLatestTripCard(null)]) {
    assert.doesNotMatch(JSON.stringify(healthy), /底图暂不可用/);
  }
});

test('send/reply response registers the NEW bot message, never the original user message', async () => {
  const card = buildLatestTripCard({}, 'old', true, { hasBasemap: false });
  const metadata = { cacheKey: 'fixture', segmentIds: [1] };
  const saved = [];
  for (const result of [{ message_id: 'bot-a' }, { data: { message_id: 'bot-b' } }, { result: { message_id: 'bot-c' } }]) {
    assert.equal((await trackMapCardDelivery(card, metadata, { stdout: JSON.stringify(result) }, {
      save: async job => saved.push(job), now: () => 0
    })).status, 'scheduled');
  }
  assert.deepEqual(saved.map(job => job.message_id), ['bot-a', 'bot-b', 'bot-c']);
  assert.equal(saved[0].next_attempt_at, 300000);
  assert.deepEqual(await trackMapCardDelivery(card, null, {}, {}), { status: 'not_needed' });
  for (const response of [{ stdout: '{}' }, { stdout: 'invalid' }, { stdout: '{"ok":false,"message_id":"not-sent"}' }]) {
    const result = await trackMapCardDelivery(card, metadata, response, { save: async () => assert.fail('must not save') });
    assert.equal(result.status, 'failed');
  }
});

test('card patch uses documented bot PATCH and rejects application-level failure', async () => {
  const card = buildLatestTripCard({}, 'updated-image', true, { hasBasemap: true });
  let args;
  await patchSentMapCard('fixture-message', card, async value => { args = value; return { stdout: '{"code":0,"data":{}}' }; });
  assert.deepEqual(args.slice(0, 3), ['api', 'PATCH', '/open-apis/im/v1/messages/fixture-message']);
  assert.deepEqual(JSON.parse(JSON.parse(args[args.indexOf('--data') + 1]).content), card);
  assert.equal(args[args.indexOf('--as') + 1], 'bot');
  for (const stdout of ['{"ok":false}', '{"code":230031}', 'invalid', '{}']) {
    await assert.rejects(patchSentMapCard('fixture-message', card, async () => ({ stdout })), /card update failed/);
  }
});

test('five minutes later only the original card image is patched; saved facts stay unchanged', async () => {
  let clock = 0; let renders = 0; const patches = [];
  const card = buildLatestTripCard({ distance_km: 2, duration_min: 5 }, 'old-image', true, { hasBasemap: false });
  const original = structuredClone(card);
  const job = makeMapRepairJob({ messageId: 'fixture-message', card, cacheKey: 'fixture', segmentIds: [1] }, clock);
  const jobs = { fixture: job };
  const run = createMapRepairProcessor({
    now: () => clock, read: async () => structuredClone(jobs),
    save: async (key, value) => { if (value) jobs[key] = value; else delete jobs[key]; },
    resolve: async () => { renders++; return { imageKey: 'new-image', mapMeta: { hasBasemap: true } }; },
    patch: async (...args) => patches.push(args)
  });
  clock = 299999; await run(); assert.equal(renders, 0);
  clock = 300000; await Promise.all([run(), run()]);
  assert.equal(renders, 1); assert.equal(patches.length, 1);
  assert.equal(patches[0][0], 'fixture-message');
  const expected = structuredClone(original);
  const index = expected.body.elements.findIndex(item => item.tag === 'img');
  expected.body.elements[index].img_key = 'new-image'; expected.body.elements.splice(index + 1, 1);
  assert.deepEqual(patches[0][1], expected); assert.deepEqual(card, original);
  assert.equal(Object.keys(jobs).length, 0);
  clock += 300000; await run(); assert.equal(patches.length, 1);
});

test('failures survive restart, are spaced five minutes apart and stop after three attempts', async () => {
  let clock = 0; let renders = 0; const logs = [];
  const card = buildLatestTripCard({}, 'old', true, { hasBasemap: false });
  const jobs = { fixture: makeMapRepairJob({ messageId: 'fixture', card, cacheKey: 'fixture', segmentIds: [1] }, clock) };
  const deps = {
    now: () => clock, read: async () => structuredClone(jobs),
    save: async (key, value) => { if (value) jobs[key] = value; else delete jobs[key]; },
    resolve: async () => { renders++; if (renders === 1) throw new Error('private boundary error'); return { mapMeta: { hasBasemap: false } }; },
    patch: async () => assert.fail('never patch degraded image'), log: event => logs.push(event)
  };
  for (let i = 1; i <= 4; i++) {
    clock = i * 300000;
    await createMapRepairProcessor(deps)(); // fresh process, same persisted state
    clock += 1;
    await createMapRepairProcessor(deps)();
  }
  assert.equal(renders, 3); assert.equal(Object.keys(jobs).length, 0);
  assert.ok(logs.some(event => event.status === 'exhausted'));
  assert.doesNotMatch(JSON.stringify(logs), /private boundary error/);
});

test('a failed PATCH retries the same original message and an expired job performs no network IO', async () => {
  let clock = 0; let patches = 0;
  const card = buildLatestTripCard({}, 'old', true, { hasBasemap: false });
  const jobs = { fixture: makeMapRepairJob({ messageId: 'original', card, cacheKey: 'fixture', segmentIds: [1] }, clock) };
  const deps = { now: () => clock, read: async () => structuredClone(jobs),
    save: async (key, value) => { if (value) jobs[key] = value; else delete jobs[key]; },
    resolve: async () => ({ imageKey: 'new', mapMeta: { hasBasemap: true } }),
    patch: async (id) => { assert.equal(id, 'original'); if (++patches === 1) throw new Error('boundary unavailable'); }
  };
  clock = 300000; await createMapRepairProcessor(deps)();
  assert.equal(jobs.fixture.attempts, 1);
  clock = 599999; await createMapRepairProcessor(deps)(); assert.equal(patches, 1);
  clock = 600000; await createMapRepairProcessor(deps)(); assert.equal(patches, 2);
  assert.equal(Object.keys(jobs).length, 0);
  jobs.expired = makeMapRepairJob({ messageId: 'expired', card, cacheKey: 'fixture', segmentIds: [1] }, 0);
  clock = 3600000;
  await createMapRepairProcessor({ ...deps, resolve: async () => assert.fail('expired job must not render') })();
  assert.equal(Object.keys(jobs).length, 0);
});

test('repair registration disk failure does not turn a sent card into a delivery failure', async () => {
  assert.deepEqual(await trackMapCardDelivery({}, { segmentIds: [1] }, { stdout: '{"message_id":"fixture"}' }, {
    save: async () => { throw new Error('disk failure'); }
  }), { status: 'failed' });
});
