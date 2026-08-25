function roundEnergy(value) {
  return Number(value.toFixed(3));
}

export function integratePowerSamples(samples) {
  const ordered = [...(samples || [])]
    .map((sample) => ({ at: new Date(sample.at), power_kw: Number(sample.power_kw) }))
    .filter((sample) => Number.isFinite(sample.at.getTime()) && Number.isFinite(sample.power_kw))
    .sort((left, right) => left.at - right.at);

  let net = 0;
  let drawn = 0;
  let regenerated = 0;
  let validSegments = 0;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const seconds = (next.at - current.at) / 1_000;
    if (seconds <= 0 || seconds > 10) continue;
    const averagePower = (current.power_kw + next.power_kw) / 2;
    const segmentEnergy = averagePower * seconds / 3_600;
    net += segmentEnergy;
    drawn += Math.max(segmentEnergy, 0);
    regenerated += Math.max(-segmentEnergy, 0);
    validSegments += 1;
  }

  if (validSegments === 0) {
    return {
      estimated_kwh: null,
      drawn_kwh: null,
      regenerated_kwh: null,
      energy_source: "unavailable",
      valid_segments: 0
    };
  }
  return {
    estimated_kwh: roundEnergy(Math.max(net, 0)),
    drawn_kwh: roundEnergy(drawn),
    regenerated_kwh: roundEnergy(regenerated),
    energy_source: "power_integration",
    valid_segments: validSegments
  };
}
