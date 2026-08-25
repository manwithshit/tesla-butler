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
  assert.equal(dueScheduledReport(now, { sent: {
    "weekly:2026-08-31": "sent",
    "monthly:2026-08": "sent"
  } }), null);
});

test("weekly report catches up after the exact Monday minute was missed", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "07"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
});

test("weekly report catches up later in the same natural week", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "02", weekday: "Wed", hour: "14", minute: "20"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
});

test("monthly report catches up after the first day of the month", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "03", weekday: "Thu", hour: "08", minute: "00"
  }, { sent: { "weekly:2026-08-31": "sent" } }), {
    period: "previous_month",
    key: "monthly:2026-09"
  });
});

test("when weekly and monthly slots overlap, each unsent report is returned", () => {
  const now = { year: "2026", month: "06", day: "01", weekday: "Mon", hour: "10", minute: "00" };
  assert.deepEqual(dueScheduledReport(now, { sent: {} }), {
    period: "previous_month",
    key: "monthly:2026-06"
  });
  assert.deepEqual(dueScheduledReport(now, { sent: { "monthly:2026-06": "sent" } }), {
    period: "previous_week",
    key: "weekly:2026-06-01"
  });
});
