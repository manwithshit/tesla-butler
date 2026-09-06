export const tripBoundaryDefaults = Object.freeze({
  finalizationDelayMs: 45_000,
  inactivityTimeoutMs: 30 * 60 * 1_000,
  boundarySignalToleranceMs: 10_000,
  parallelLockWindowMs: 10 * 60 * 1_000,
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
  const savedSession = saved.session ? clone(saved.session) : null;
  return {
    version: 3,
    initialized: Boolean(saved.initialized),
    last_processed_drive_id: Number(saved.last_processed_drive_id) || 0,
    session: savedSession ? {
      ...savedSession,
      active_started_at: savedSession.active_started_at || null,
      boundary_candidate: savedSession.boundary_candidate || null
    } : null,
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
    active_started_at: phase === "driving" ? at : null,
    last_event_at: at,
    parked_at: null,
    finalize_at: null,
    finalization_reason: null,
    boundary_candidate: null
  };
}

function candidateIsComplete(candidate) {
  return timeMs(candidate?.door_open_at) !== null
    && timeMs(candidate?.door_closed_at) !== null
    && timeMs(candidate?.locked_at) !== null
    && timeMs(candidate.door_open_at) < timeMs(candidate.door_closed_at)
    && timeMs(candidate.door_closed_at) < timeMs(candidate.locked_at);
}

function candidateMatchesParkedSession(session) {
  if (!candidateIsComplete(session?.boundary_candidate)) return false;
  const parkedAt = timeMs(session.parked_at);
  const openedAt = timeMs(session.boundary_candidate.door_open_at);
  return parkedAt !== null
    && openedAt >= parkedAt - tripBoundaryDefaults.boundarySignalToleranceMs;
}

function finalizeFromCandidate(session) {
  if (!candidateMatchesParkedSession(session)) return false;
  session.phase = "finalizing";
  session.finalization_reason = "locked";
  session.finalize_at = plusMs(
    session.boundary_candidate.locked_at,
    tripBoundaryDefaults.finalizationDelayMs
  );
  session.last_event_at = session.boundary_candidate.locked_at;
  return true;
}

function finalizeFromParallelLock(session, at) {
  const parkedAt = timeMs(session?.parked_at);
  const lockedAt = timeMs(at);
  if (
    !session
    || session.phase === "driving"
    || session.phase === "finalizing"
    || session.segment_ids.length === 0
    || parkedAt === null
    || lockedAt === null
    || lockedAt < parkedAt - tripBoundaryDefaults.boundarySignalToleranceMs
    || lockedAt - parkedAt > tripBoundaryDefaults.parallelLockWindowMs
  ) return false;
  session.phase = "finalizing";
  session.finalization_reason = "locked_parallel";
  session.finalize_at = plusMs(at, tripBoundaryDefaults.finalizationDelayMs);
  session.last_event_at = at;
  return true;
}

export function summarizeTripState(state) {
  const session = state?.session || null;
  const candidate = session?.boundary_candidate || null;
  const boundaryStage = candidate?.locked_at
    ? "locked"
    : candidate?.door_closed_at
      ? "door_closed"
      : candidate?.door_open_at
        ? "door_open"
        : "none";
  return {
    phase: session?.phase || "idle",
    segment_count: session?.segment_ids?.length || 0,
    pending_count: Object.keys(state?.pending_events || {}).length,
    reason: session?.finalization_reason || "none",
    active: Boolean(session?.active_started_at),
    boundary_stage: boundaryStage
  };
}

export class TripSessionTracker {
  constructor(saved = {}) {
    this.state = normalizeState(saved);
  }

  restore(saved) {
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
      snapshot?.active
      && this.state.session?.phase === "finalizing"
      && this.state.session.finalization_reason === "locked_parallel"
      && timeMs(snapshot.active.start_at) !== null
      && timeMs(this.state.session.finalize_at) !== null
      && timeMs(snapshot.active.start_at) <= timeMs(this.state.session.finalize_at)
    ) {
      this.state.session.phase = "driving";
      this.state.session.active_started_at = snapshot.active.start_at || at;
      this.state.session.finalize_at = null;
      this.state.session.finalization_reason = null;
      this.state.session.boundary_candidate = null;
    }
    if (
      snapshot?.active
      && this.state.session?.phase === "finalizing"
      && this.state.session.segment_ids.length > 0
      && !this.state.session.segment_ids.includes(Number(snapshot.active.id) || 0)
      && timeMs(snapshot.active.start_at) !== timeMs(this.state.session.active_started_at)
    ) {
      this.queueCurrentSession();
    }
    if (snapshot?.active && !this.state.session) {
      this.state.session = newSession(snapshot.active.start_at || at);
    }
    if (snapshot?.active && this.state.session?.phase === "driving") {
      this.state.session.active_started_at = snapshot.active.start_at || at;
    }
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
      this.state.session.active_started_at = null;
      if (!wasFinalizing) this.state.session.last_event_at = drive.end_at || at;
      this.state.last_processed_drive_id = id;
    }
    if (
      !snapshot?.active
      && this.state.session
      && !this.state.session.active_started_at
      && this.state.session.phase !== "finalizing"
    ) {
      if (!finalizeFromCandidate(this.state.session)) {
        const candidate = this.state.session.boundary_candidate;
        if (
          candidateIsComplete(candidate)
          && timeMs(candidate.door_open_at)
            < timeMs(this.state.session.parked_at) - tripBoundaryDefaults.boundarySignalToleranceMs
        ) {
          this.state.session.boundary_candidate = null;
        }
      }
    }
    if (
      snapshot?.active
      && this.state.session
      && this.state.session.phase !== "driving"
      && this.state.session.phase !== "finalizing"
    ) {
      this.state.session.phase = "driving";
      this.state.session.active_started_at = snapshot.active.start_at || at;
      this.state.session.finalize_at = null;
      this.state.session.finalization_reason = null;
      this.state.session.boundary_candidate = null;
    }
    if (
      !snapshot?.active
      && this.state.session
      && !["driving", "finalizing"].includes(this.state.session.phase)
      && timeMs(at) !== null
      && timeMs(this.state.session.parked_at) !== null
      && timeMs(at) - timeMs(this.state.session.parked_at) >= tripBoundaryDefaults.inactivityTimeoutMs
    ) {
      this.state.session.finalization_reason = "inactivity_timeout";
      this.queueCurrentSession();
    }
    if (
      this.state.session?.phase === "finalizing"
      && !snapshot?.active
      && !this.state.session.active_started_at
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
    if (!session || session.phase === "finalizing") return true;
    session.last_event_at = at;
    if (field === "driver_front_door_open" && previous === false && value === true) {
      session.boundary_candidate = {
        door_open_at: at,
        door_closed_at: null,
        locked_at: null
      };
      if (session.phase !== "driving") session.phase = "door_open";
    } else if (
      field === "driver_front_door_open"
      && previous === true
      && value === false
      && session.boundary_candidate?.door_open_at
    ) {
      session.boundary_candidate.door_closed_at = at;
      if (session.phase !== "driving") session.phase = "door_closed";
    } else if (
      field === "locked"
      && previous === false
      && value === true
    ) {
      if (session.boundary_candidate?.door_closed_at) {
        session.boundary_candidate.locked_at = at;
        if (
          session.phase !== "driving"
          && !finalizeFromCandidate(session)
        ) finalizeFromParallelLock(session, at);
      } else {
        finalizeFromParallelLock(session, at);
      }
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
