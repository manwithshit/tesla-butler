import test from "node:test";
import assert from "node:assert/strict";

import { driveEnergyTimelineSincePredicate } from "../src/teslamate.mjs";

test("pricing timeline compares TeslaMate UTC-naive timestamps without the database session offset", () => {
  assert.equal(
    driveEnergyTimelineSincePredicate("2026-08-31T01:02:03"),
    "d.start_date >= ('2026-08-31T01:02:03.000Z'::timestamptz AT TIME ZONE 'UTC')"
  );
  assert.equal(
    driveEnergyTimelineSincePredicate("2026-08-31T01:02:03.000Z"),
    "d.start_date >= ('2026-08-31T01:02:03.000Z'::timestamptz AT TIME ZONE 'UTC')"
  );
});

test("pricing timeline rejects an invalid lower bound before building SQL", () => {
  assert.throws(
    () => driveEnergyTimelineSincePredicate("not-a-date"),
    /invalid drive energy timeline start/
  );
});
