export function eventDedupeKey(eventKey, event) {
  if (eventKey === "card.action.trigger") {
    return event.event_id || `${event.message_id || "card"}:${event.action_value || "action"}`;
  }
  return event.message_id || event.event_id;
}
