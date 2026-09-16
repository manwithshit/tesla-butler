import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTripAudit, pruneTripAudit } from '../src/trip-audit.mjs';

test('audit keeps only permitted diagnostics, expires after 72 hours and is size bounded', () => {
  const at = '2026-09-16T01:00:00Z';
  const rows = appendTripAudit([], { at, event: 'signal', field: 'locked', value: true,
    retained: false, phase: 'driving', db_active: false, decision: 'deferred',
    chat_id: 'private', lat: 0, lng: 0, token: 'private', id: 'private', note: 'private' });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at','db_active','decision','event','field','phase','retained','value'].sort());
  assert.doesNotMatch(JSON.stringify(rows), /private|chat_id|token|lat|lng/);
  assert.equal(pruneTripAudit(rows, '2026-09-19T01:00:01Z').length, 0);
  assert.equal(pruneTripAudit(Array(5000).fill(rows[0]), at).length, 2000);
});

test('naive TeslaMate milestone timestamps are interpreted as UTC in diagnostics', () => {
  const entries = appendTripAudit([], { at: '2026-09-16T01:00:00', event: 'boundary', decision: 'queued' });
  assert.equal(entries[0].at, '2026-09-16T01:00:00.000Z');
});
