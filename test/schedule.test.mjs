import test from "node:test";
import assert from "node:assert/strict";
import { dueScheduledReport } from "../src/schedule.mjs";

test("natural weekly and monthly reports have automatic delivery slots", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "00"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "01", weekday: "Tue", hour: "09", minute: "10"
  }, { sent: {} }), {
    period: "previous_month",
    key: "monthly:2026-09"
  });
});

test("an automatic report is not delivered twice", () => {
  const now = { year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "00" };
  assert.equal(dueScheduledReport(now, { sent: { "weekly:2026-08-31": "sent" } }), null);
});
