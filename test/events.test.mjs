import test from "node:test";
import assert from "node:assert/strict";
import { eventDedupeKey } from "../src/events.mjs";

test("card callbacks on the same card use their own event ids", () => {
  const first = eventDedupeKey("card.action.trigger", { message_id: "same-card", event_id: "click-1" });
  const second = eventDedupeKey("card.action.trigger", { message_id: "same-card", event_id: "click-2" });
  assert.notEqual(first, second);
});

test("message events remain deduplicated by message id", () => {
  assert.equal(eventDedupeKey("im.message.receive_v1", { message_id: "message-1", event_id: "event-1" }), "message-1");
});

test("form callbacks without event ids include the action name and a private value digest", () => {
  const first = eventDedupeKey("card.action.trigger", {
    message_id: "same-card",
    action_name: "default_electricity_rate_submit",
    form_value: '{"default_rate":"0.60"}'
  });
  const second = eventDedupeKey("card.action.trigger", {
    message_id: "same-card",
    action_name: "default_electricity_rate_submit",
    form_value: '{"default_rate":"0.80"}'
  });

  assert.notEqual(first, second);
  assert.doesNotMatch(first, /0\.60|default_rate/);
});
