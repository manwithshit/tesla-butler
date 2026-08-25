const supportedFields = new Set([
  "battery_level",
  "plugged_in",
  "charging_state",
  "charge_limit_soc",
  "charger_power",
  "charge_energy_added",
  "time_to_full_charge"
]);

const numericFields = new Set([
  "battery_level",
  "charge_limit_soc",
  "charger_power",
  "charge_energy_added",
  "time_to_full_charge"
]);

const terminalStates = new Set(["complete", "disconnected"]);
const freshnessWindowMs = 2 * 60 * 1000;
const sessionOrderingToleranceMs = 10 * 1000;
const sessionFields = ["time_to_full_charge", "charger_power", "charge_energy_added"];

function parseValue(field, raw) {
  if (numericFields.has(field)) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  if (field === "plugged_in") return String(raw).trim().toLowerCase() === "true";
  return String(raw).trim();
}

export function parseTeslaMateTopic(topic, payload) {
  const match = String(topic).match(/^teslamate\/cars\/([^/]+)\/([^/]+)$/);
  if (!match || !supportedFields.has(match[2])) return null;
  return { carId: match[1], field: match[2], value: parseValue(match[2], payload) };
}

function initialCar(value = {}) {
  return {
    snapshot: { ...(value.snapshot || {}) },
    field_updated_at: { ...(value.field_updated_at || {}) },
    charging_state: value.charging_state || null,
    session: value.session ? { ...value.session } : null
  };
}

function milliseconds(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function isFresh(fieldAt, nowAt, sessionAt = null) {
  const fieldMs = milliseconds(fieldAt);
  const nowMs = milliseconds(nowAt);
  if (fieldMs === null || nowMs === null || fieldMs > nowMs) return false;
  if (nowMs - fieldMs > freshnessWindowMs) return false;
  const sessionMs = milliseconds(sessionAt);
  return sessionMs === null || fieldMs >= sessionMs - sessionOrderingToleranceMs;
}

function nearLimitFromCurrentData(car, at) {
  if (!car.session) return false;
  const remaining = Number(car.snapshot.time_to_full_charge);
  const battery = Number(car.snapshot.battery_level);
  const limit = Number(car.snapshot.charge_limit_soc);
  const etaFresh = isFresh(car.field_updated_at.time_to_full_charge, at, car.session.started_at);
  const batteryFresh = isFresh(car.field_updated_at.battery_level, at, car.session.started_at);
  const remainingIsNear = etaFresh && Number.isFinite(remaining) && remaining > 0 && remaining <= 0.25;
  const batteryIsNear = !etaFresh
    && batteryFresh
    && Number.isFinite(battery) && Number.isFinite(limit)
    && battery >= limit - 5 && battery < limit;
  return remainingIsNear || batteryIsNear;
}

export class ChargingTracker {
  constructor(saved = {}) {
    this.cars = new Map(Object.entries(saved.cars || {}).map(([id, value]) => [id, initialCar(value)]));
  }

  update(carId, field, value, at = new Date().toISOString()) {
    const id = String(carId);
    const car = this.cars.get(id) || initialCar();
    this.cars.set(id, car);
    car.snapshot[field] = value;
    car.snapshot.updated_at = at;
    car.field_updated_at[field] = at;
    const events = [];

    if (field === "charging_state") {
      const normalized = String(value || "").toLowerCase();
      car.charging_state = normalized;
      if (normalized === "charging" && !car.session) {
        for (const sessionField of sessionFields) {
          if (!isFresh(car.field_updated_at[sessionField], at, at)) {
            delete car.snapshot[sessionField];
            delete car.field_updated_at[sessionField];
          }
        }
        car.session = {
          id: `charge-${id}-${new Date(at).getTime()}`,
          started_sent: true,
          near_limit_sent: false,
          started_at: at
        };
        events.push({ type: "started", carId: id, sessionId: car.session.id, snapshot: { ...car.snapshot } });
      } else if (terminalStates.has(normalized)) {
        car.session = null;
        for (const sessionField of sessionFields) {
          delete car.snapshot[sessionField];
          delete car.field_updated_at[sessionField];
        }
      }
    }

    if (car.charging_state === "charging" && car.session && !car.session.near_limit_sent) {
      if (nearLimitFromCurrentData(car, at)) {
        car.session.near_limit_sent = true;
        events.push({ type: "near_limit", carId: id, sessionId: car.session.id, snapshot: { ...car.snapshot } });
      }
    }
    return events;
  }

  snapshot(carId) {
    return { ...(this.cars.get(String(carId))?.snapshot || {}) };
  }

  canSend(event, at = new Date().toISOString()) {
    if (!event?.carId || !event?.sessionId) return false;
    const car = this.cars.get(String(event.carId));
    if (!car?.session || car.session.id !== event.sessionId || car.charging_state !== "charging") return false;
    if (event.type === "started") return true;
    return event.type === "near_limit" && nearLimitFromCurrentData(car, at);
  }

  toJSON() {
    return {
      cars: Object.fromEntries([...this.cars.entries()].map(([id, value]) => [id, {
        snapshot: value.snapshot,
        field_updated_at: value.field_updated_at,
        charging_state: value.charging_state,
        session: value.session
      }]))
    };
  }
}
