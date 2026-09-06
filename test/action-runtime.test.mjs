import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserAction } from '../src/action-runtime.mjs';

test('a transient query failure retries once and only delivers the successful result', async () => {
  let calls = 0; let notices = 0;
  const result = await runUserAction('latest_trip', {}, {
    execute: async () => { if (++calls === 1) throw new Error('offline'); },
    notify: async () => { notices++; }, wait: async () => {}, log: () => {}
  });
  assert.equal(result.status, 'success'); assert.equal(calls, 2); assert.equal(notices, 0);
});

test('persistent failure gives one clear response, and feedback failure stays retryable', async () => {
  let notices = 0;
  const ops = { execute: async () => { throw new Error('private database detail'); },
    notify: async text => { notices++; assert.match(text, /稍后/); assert.doesNotMatch(text, /private/); },
    wait: async () => {}, log: () => {} };
  assert.equal((await runUserAction('menu', {}, ops)).status, 'failed_with_feedback');
  assert.equal(notices, 1);
  await assert.rejects(runUserAction('menu', {}, { ...ops, notify: async () => { throw new Error('delivery failed'); } }));
});
