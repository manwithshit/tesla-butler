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
const completedProcessFields = [
  "start_battery_level",
  "end_battery_level",
  "duration_min",
  "start_at",
  "end_at"
];

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
    session: value.session ? { ...value.session } : null,
    process: value.process ? { ...value.process } : null
  };
}

function processSnapshot(process) {
  return {
    battery_level: process.end_battery_level ?? process.latest_battery_level ?? process.start_battery_level ?? null,
    charger_power: process.latest_charger_power ?? null,
    charge_energy_added: process.charge_energy_added ?? process.latest_charge_energy_added ?? null,
    start_battery_level: process.start_battery_level ?? null,
    end_battery_level: process.end_battery_level ?? null,
    duration_min: process.duration_min ?? null,
    start_at: process.start_at ?? null,
    end_at: process.end_at ?? null
  };
}

function milliseconds(value) {
  const raw = String(value || "").trim();
  const normalized = raw && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw;
  const result = new Date(normalized).getTime();
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

function isFreshSinceSession(fieldAt, nowAt, sessionAt) {
  const fieldMs = milliseconds(fieldAt);
  const nowMs = milliseconds(nowAt);
  const sessionMs = milliseconds(sessionAt);
  return fieldMs !== null
    && nowMs !== null
    && sessionMs !== null
    && fieldMs >= sessionMs
    && fieldMs <= nowMs
    && nowMs - fieldMs <= freshnessWindowMs;
}

function nearLimitFromCurrentData(car, at) {
  if (!car.session) return false;
  const remaining = Number(car.snapshot.time_to_full_charge);
  const battery = Number(car.snapshot.battery_level);
  const limit = Number(car.snapshot.charge_limit_soc);
  const etaFresh = isFresh(car.field_updated_at.time_to_full_charge, at, car.session.started_at);
  const batteryFresh = isFresh(car.field_updated_at.battery_level, at, car.session.started_at);
  const batteryIsInFinalBand = batteryFresh
    && Number.isFinite(battery) && Number.isFinite(limit)
    && battery >= limit - 10 && battery < limit;
  const remainingIsNear = etaFresh
    && batteryIsInFinalBand
    && Number.isFinite(remaining) && remaining > 0 && remaining <= 0.25;
  const batteryIsNear = !etaFresh
    && batteryFresh
    && Number.isFinite(battery) && Number.isFinite(limit)
    && battery >= limit - 5 && battery < limit;
  return remainingIsNear || batteryIsNear;
}

export class ChargingTracker {
  constructor(saved = {}) {
    this.cars = new Map(Object.entries(saved.cars || {}).map(([id, value]) => [id, initialCar(value)]));
    this.pendingEventsByKey = new Map(Object.entries(saved.pending_events || {}));
  }

  queue(events) {
    for (const event of events) {
      event.eventKey ||= `${event.sessionId}:${event.type}`;
      this.pendingEventsByKey.set(event.eventKey, { ...event, snapshot: { ...event.snapshot } });
    }
    return events;
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
        for (const processField of completedProcessFields) {
          delete car.snapshot[processField];
        }
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
    return this.queue(events);
  }

  reconcileProcess(process, at = new Date().toISOString()) {
    if (!process?.id || !process?.car_id) return [];
    const id = String(process.car_id);
    const processId = String(process.id);
    const car = this.cars.get(id) || initialCar();
    this.cars.set(id, car);
    const databaseSnapshot = processSnapshot(process);
    Object.assign(car.snapshot, databaseSnapshot, { updated_at: at });
    if (databaseSnapshot.battery_level !== null) {
      car.field_updated_at.battery_level = at;
    }

    if (!process.end_at) {
      if (car.process?.id === processId) return [];
      const alreadyStarted = Boolean(car.session);
      car.charging_state = "charging";
      car.session ||= {
        id: `charge-db-${processId}`,
        started_sent: true,
        near_limit_sent: false,
        started_at: process.start_at || at
      };
      car.process = { id: processId, active: true, started_sent: true, completed_sent: false };
      return this.queue(alreadyStarted
        ? []
        : [{ type: "started", carId: id, sessionId: car.session.id, processId, snapshot: { ...car.snapshot } }]);
    }

    const processIsNew = car.process?.id !== processId;
    const endedAtMs = milliseconds(process.end_at);
    const observedAtMs = milliseconds(at);
    const endedRecently = endedAtMs !== null
      && observedAtMs !== null
      && observedAtMs >= endedAtMs
      && observedAtMs - endedAtMs <= freshnessWindowMs;
    const shouldComplete = (car.process?.id === processId
      && car.process.active
      && !car.process.completed_sent)
      || (processIsNew && endedRecently);
    const sessionId = car.session?.id || `charge-db-${processId}`;
    car.process = { id: processId, active: false, started_sent: true, completed_sent: true };
    car.charging_state = "complete";
    car.session = null;
    return this.queue(shouldComplete
      ? [{ type: "completed", carId: id, sessionId, processId, snapshot: { ...car.snapshot } }]
      : []);
  }

  pendingEvents() {
    return [...this.pendingEventsByKey.values()].map((event) => ({
      ...event,
      snapshot: {
        ...event.snapshot,
        ...(event.type === "completed"
          ? {}
          : this.cars.get(String(event.carId))?.snapshot || {})
      }
    }));
  }

  acknowledge(event) {
    if (event?.eventKey) this.pendingEventsByKey.delete(event.eventKey);
  }

  snapshot(carId) {
    return { ...(this.cars.get(String(carId))?.snapshot || {}) };
  }

  canSend(event, at = new Date().toISOString()) {
    if (!event?.carId || !event?.sessionId) return false;
    const car = this.cars.get(String(event.carId));
    if (event.type === "completed") {
      return Boolean(car?.process
        && car.process.id === String(event.processId)
        && !car.process.active
        && car.process.completed_sent);
    }
    if (!car?.session || car.session.id !== event.sessionId || car.charging_state !== "charging") return false;
    if (event.type === "started") {
      return Number.isFinite(Number(car.snapshot.battery_level))
        && isFreshSinceSession(
          car.field_updated_at.battery_level,
          at,
          car.session.started_at
        );
    }
    return event.type === "near_limit" && nearLimitFromCurrentData(car, at);
  }

  shouldWait(event) {
    if (event?.type !== "started" || !event.carId || !event.sessionId) return false;
    const car = this.cars.get(String(event.carId));
    return Boolean(car?.session
      && car.session.id === event.sessionId
      && car.charging_state === "charging");
  }

  toJSON() {
    return {
      pending_events: Object.fromEntries(this.pendingEventsByKey),
      cars: Object.fromEntries([...this.cars.entries()].map(([id, value]) => [id, {
        snapshot: value.snapshot,
        field_updated_at: value.field_updated_at,
        charging_state: value.charging_state,
        session: value.session,
        process: value.process
      }]))
    };
  }
}
