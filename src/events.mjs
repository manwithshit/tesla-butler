import crypto from "node:crypto";

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

export function eventDedupeKey(eventKey, event) {
  if (eventKey === "card.action.trigger") {
    const fallbackPayload = event.form_value || event.action_value || event.input_value || "action";
    return event.event_id
      || `${event.message_id || "card"}:${event.action_name || event.action_tag || "action"}:${shortHash(fallbackPayload)}`;
  }
  return event.message_id || event.event_id;
}
