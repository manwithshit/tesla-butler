export const tripBoundaryDefaults = Object.freeze({
  finalizationDelayMs: 45_000,
  inactivityTimeoutMs: 60 * 60 * 1_000,
  pollMs: 15_000
});

function clone(value) {
  return structuredClone(value);
}

function timeMs(value) {
  const raw = String(value || "").trim();
  const normalized = raw && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw;
  const result = new Date(normalized).getTime();
  return Number.isFinite(result) ? result : null;
}

function plusMs(value, durationMs) {
  const base = timeMs(value);
  return base === null ? null : new Date(base + durationMs).toISOString();
}

function emptySignal() {
  return { initialized: false, value: null };
}

function normalizePendingEvents(savedEvents) {
  const entries = Object.entries(savedEvents || {}).flatMap(([savedKey, event]) => {
    const segmentIds = [...new Set((event?.segment_ids || event?.trip?.segment_ids || [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0))];
    if (segmentIds.length === 0) return [];
    const eventKey = String(event?.eventKey || savedKey || `trip-${segmentIds.join("-")}`);
    return [[eventKey, {
      type: "completed_trip",
      eventKey,
      tripId: String(event?.tripId || eventKey),
      segment_ids: segmentIds,
      reason: event?.reason || "restored_pending"
    }]];
  });
  return Object.fromEntries(entries);
}

function normalizeState(saved) {
  return {
    version: 2,
    initialized: Boolean(saved.initialized),
    last_processed_drive_id: Number(saved.last_processed_drive_id) || 0,
    session: saved.session ? clone(saved.session) : null,
    signals: {
      locked: { ...emptySignal(), ...(saved.signals?.locked || {}) },
      driver_front_door_open: { ...emptySignal(), ...(saved.signals?.driver_front_door_open || {}) }
    },
    pending_events: normalizePendingEvents(saved.pending_events),
    sent_keys: clone(saved.sent_keys || {})
  };
}

function newSession(at, phase = "driving") {
  return {
    phase,
    segment_ids: [],
    started_at: at,
    last_event_at: at,
    parked_at: null,
    finalize_at: null,
    finalization_reason: null
  };
}

export class TripSessionTracker {
  constructor(saved = {}) {
    this.state = normalizeState(saved);
  }

  reconcile(snapshot, at = new Date().toISOString()) {
    const completed = snapshot?.completed || [];
    if (!this.state.initialized) {
      this.state.initialized = true;
      this.state.last_processed_drive_id = Math.max(
        0,
        ...completed.map((drive) => Number(drive.id) || 0)
      );
    }
    if (
      this.state.session
      && !["driving", "finalizing"].includes(this.state.session.phase)
      && timeMs(at) !== null
      && timeMs(this.state.session.last_event_at) !== null
      && timeMs(at) - timeMs(this.state.session.last_event_at) >= tripBoundaryDefaults.inactivityTimeoutMs
    ) {
      this.state.session.finalization_reason = "inactivity_timeout";
      this.queueCurrentSession();
    }
    if (
      snapshot?.active
      && this.state.session?.phase === "finalizing"
      && this.state.session.segment_ids.length > 0
    ) {
      this.queueCurrentSession();
    }
    if (snapshot?.active && !this.state.session) this.state.session = newSession(at);
    for (const drive of completed) {
      const id = Number(drive.id) || 0;
      if (id <= this.state.last_processed_drive_id) continue;
      const gapMs = timeMs(drive.start_at) - timeMs(this.state.session?.parked_at);
      const recoveredBoundary = this.state.session?.segment_ids?.length > 0
        && (Boolean(drive.charging_between)
          || (Number.isFinite(gapMs) && gapMs >= tripBoundaryDefaults.inactivityTimeoutMs));
      if (recoveredBoundary) {
        this.state.session.finalization_reason = drive.charging_between
          ? "charging_between"
          : "inactivity_timeout";
        this.queueCurrentSession();
      }
      if (!this.state.session) this.state.session = newSession(drive.start_at || at, "parked");
      const wasFinalizing = this.state.session.phase === "finalizing";
      if (!this.state.session.segment_ids.includes(id)) this.state.session.segment_ids.push(id);
      if (!wasFinalizing) this.state.session.phase = "parked";
      this.state.session.parked_at = drive.end_at || at;
      if (!wasFinalizing) this.state.session.last_event_at = drive.end_at || at;
      this.state.last_processed_drive_id = id;
    }
    if (
      snapshot?.active
      && this.state.session
      && this.state.session.phase !== "driving"
      && this.state.session.phase !== "finalizing"
      && timeMs(at) - timeMs(this.state.session.last_event_at) < tripBoundaryDefaults.inactivityTimeoutMs
    ) {
      this.state.session.phase = "driving";
      this.state.session.parked_at = null;
      this.state.session.finalize_at = null;
      this.state.session.finalization_reason = null;
    }
    if (
      this.state.session?.phase === "finalizing"
      && timeMs(at) !== null
      && timeMs(this.state.session.finalize_at) !== null
      && timeMs(at) >= timeMs(this.state.session.finalize_at)
    ) {
      this.queueCurrentSession();
    }
    return this.pendingEvents();
  }

  observeVehicleSignal(field, value, at, { retained = false } = {}) {
    const signal = this.state.signals[field];
    if (!signal || typeof value !== "boolean") return false;
    if (!signal.initialized || retained) {
      signal.initialized = true;
      signal.value = value;
      return true;
    }
    const previous = signal.value;
    if (previous === value) return false;
    signal.value = value;
    const session = this.state.session;
    if (!session || session.phase === "driving" || session.phase === "finalizing") return true;
    session.last_event_at = at;
    if (field === "driver_front_door_open" && previous === false && value === true && session.phase === "parked") {
      session.phase = "door_open";
    } else if (
      field === "driver_front_door_open"
      && previous === true
      && value === false
      && session.phase === "door_open"
    ) {
      session.phase = "door_closed";
    } else if (field === "locked" && previous === false && value === true && session.phase === "door_closed") {
      session.phase = "finalizing";
      session.finalization_reason = "locked";
      session.finalize_at = plusMs(at, tripBoundaryDefaults.finalizationDelayMs);
    }
    return true;
  }

  observeChargingStarted(at = new Date().toISOString()) {
    const session = this.state.session;
    if (!session || session.phase === "finalizing") return false;
    session.phase = "finalizing";
    session.last_event_at = at;
    session.finalization_reason = "charging_started";
    session.finalize_at = plusMs(at, tripBoundaryDefaults.finalizationDelayMs);
    return true;
  }

  queueCurrentSession() {
    const segmentIds = this.state.session?.segment_ids || [];
    if (segmentIds.length === 0) return false;
    const eventKey = `trip-${segmentIds.join("-")}`;
    if (!this.state.pending_events[eventKey] && !this.state.sent_keys[eventKey]) {
      this.state.pending_events[eventKey] = {
        type: "completed_trip",
        eventKey,
        tripId: eventKey,
        segment_ids: [...segmentIds],
        reason: this.state.session.finalization_reason
      };
    }
    this.state.session = null;
    return true;
  }

  acknowledge(event, at = new Date().toISOString()) {
    const eventKey = event?.eventKey;
    if (!eventKey || !this.state.pending_events[eventKey]) return false;
    delete this.state.pending_events[eventKey];
    this.state.sent_keys[eventKey] = at;
    return true;
  }

  pendingEvents() {
    return clone(Object.values(this.state.pending_events));
  }

  toJSON() {
    return clone(this.state);
  }
}
