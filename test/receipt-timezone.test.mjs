import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('receipt period boundaries are Shanghai boundaries in every host timezone', () => {
  const cases = [
    ['month', '2026-09-06T04:00:00Z', '2026-09-01 00:30'],
    ['previous_month', '2026-09-06T04:00:00Z', '2026-08-31 23:30'],
    ['week', '2026-09-06T04:00:00Z', '2026-08-31 00:30'],
    ['previous_week', '2026-09-06T04:00:00Z', '2026-08-30 23:30'],
    ['previous_month', '2027-01-02T04:00:00Z', '2026-12-01 00:00']
  ];
  for (const TZ of ['Asia/Shanghai', 'Asia/Ho_Chi_Minh', 'UTC']) {
    const script = `import { getReceiptTotals } from './src/store.mjs';
      const result = []; for (const [period, now, charged_at] of ${JSON.stringify(cases)}) {
        result.push((await getReceiptTotals(period, { now: new Date(now), store: { receipts: {
          fixture: { status: 'confirmed', fields: { charged_at, amount_cny: 1, energy_kwh: 1 } }
        } } })).count);
      } console.log(JSON.stringify(result));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8'
    });
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), cases.map(() => 1), TZ);
  }
});
