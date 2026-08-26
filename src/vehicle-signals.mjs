export const tripSignalFields = Object.freeze([
  "locked",
  "driver_front_door_open"
]);

export const tripSignalTopics = Object.freeze(
  tripSignalFields.map((field) => `teslamate/cars/+/${field}`)
);

export function parseVehicleSignalTopic(topic, payload) {
  const match = /^teslamate\/cars\/[^/]+\/(locked|driver_front_door_open)$/.exec(String(topic));
  if (!match) return null;
  const raw = String(payload).trim();
  if (raw !== "true" && raw !== "false") return null;
  return { field: match[1], value: raw === "true" };
}
