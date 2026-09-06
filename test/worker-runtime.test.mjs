import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue, createEventProcessor } from '../src/worker-runtime.mjs';

test('slow work coalesces repeated polls while preserving every real event in order', async () => {
  const q = createSerialQueue(); const seen = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const poll = q.enqueue(async () => { await blocked; seen.push('poll'); }, 'poll');
  for (let i = 0; i < 100; i++) assert.equal(q.enqueue(() => seen.push('extra'), 'poll'), poll);
  const a = q.enqueue(() => seen.push('a'));
  const b = q.enqueue(() => seen.push('b'));
  assert.equal(q.size, 3);
  release(); await Promise.all([poll, a, b]);
  assert.deepEqual(seen, ['poll', 'a', 'b']);
  assert.equal(q.size, 0);
  await q.enqueue(() => { throw new Error('temporary'); }).catch(() => {});
  await q.enqueue(() => seen.push('recovered'));
  assert.equal(seen.at(-1), 'recovered');
});

test('event success is deduplicated, failures can be redelivered, and concurrent duplicates join one operation', async () => {
  const process = createEventProcessor(); let calls = 0; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const handler = async () => { calls++; await blocked; throw new Error('offline'); };
  const a = process('fixture', handler); const b = process('fixture', handler);
  assert.equal(a, b); release(); await assert.rejects(a);
  await process('fixture', async () => { calls++; });
  await process('fixture', async () => { calls++; });
  assert.equal(calls, 2);
});
