function instant(value) {
  const text = String(value || '');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
}

// Reconstruct only the database facts that were already true at observation
// time. In particular, a later drive must not turn an earlier parked lock into
// an in-motion lock, nor can a late auto-lock split an already completed drive.
export function snapshotAt(snapshot, at) {
  const time = instant(at);
  const completed = (snapshot.completed || []).filter(d => instant(d.end_at) <= time);
  const active = [...(snapshot.completed || []), ...(snapshot.active ? [snapshot.active] : [])]
    .find(d => instant(d.start_at) <= time && (!d.end_at || instant(d.end_at) > time)) || null;
  return { completed, active };
}

export function replayVehicleSignals(tracker, snapshot, signals, now) {
  const processed = [];
  let previousAt = null;
  const advance = (until) => {
    if (!previousAt) return;
    const milestones = [...(snapshot.completed || []), ...(snapshot.active ? [snapshot.active] : [])]
      .flatMap(d => [d.start_at, d.end_at]).filter(Boolean)
      .filter(at => instant(at) > instant(previousAt) && instant(at) <= instant(until))
      .sort((a, b) => instant(a) - instant(b));
    for (const at of milestones) tracker.reconcile(snapshotAt(snapshot, at), at);
  };
  for (const signal of [...signals].sort((a, b) => instant(a.at) - instant(b.at))) {
    if (!['locked', 'driver_front_door_open'].includes(signal.field)
      || typeof signal.value !== 'boolean' || !Number.isFinite(instant(signal.at))) {
      throw new Error('invalid persisted vehicle signal');
    }
    const session = tracker.toJSON().session;
    // A stale observation from before the current session may only establish
    // a baseline. Never apply its edge to a different, newer journey.
    const stale = session && instant(signal.at) < instant(session.started_at);
    advance(signal.at);
    if (!stale) tracker.reconcile(snapshotAt(snapshot, signal.at), signal.at);
    tracker.observeVehicleSignal(signal.field, signal.value, signal.at, {
      retained: Boolean(signal.retained || stale)
    });
    processed.push(signal.id);
    previousAt = signal.at;
  }
  if (now) advance(now);
  return processed;
}
