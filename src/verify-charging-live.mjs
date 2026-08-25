import { assertCard, buildChargingStatusCard } from "./cards.mjs";
import { ChargingTracker } from "./charging.mjs";
import { getLatestChargingProcess } from "./teslamate.mjs";

const startedAt = performance.now();
const latestProcess = await getLatestChargingProcess();
const queryMs = Math.round((performance.now() - startedAt) * 10) / 10;
if (queryMs >= 3_000) throw new Error(`charging process query is too slow: ${queryMs}ms`);

let status = "no_history";
let cardBlocks = null;
let staleReplayEvents = null;
if (latestProcess) {
  if (!latestProcess.id || !latestProcess.car_id || !latestProcess.start_at) {
    throw new Error("latest charging process is missing required fields");
  }
  status = latestProcess.end_at ? "completed" : "active";
  if (latestProcess.end_at) {
    if (latestProcess.duration_min === null || latestProcess.charge_energy_added === null) {
      throw new Error("completed charging process is missing duration or energy");
    }
    cardBlocks = assertCard(buildChargingStatusCard("completed", {
      start_at: latestProcess.start_at,
      end_at: latestProcess.end_at,
      start_battery_level: latestProcess.start_battery_level,
      end_battery_level: latestProcess.end_battery_level,
      charge_energy_added: latestProcess.charge_energy_added,
      duration_min: latestProcess.duration_min
    })).body.elements.length;

    const endedAt = new Date(`${String(latestProcess.end_at).replace(/Z$/i, "")}Z`).getTime();
    if (Date.now() - endedAt > 120_000) {
      const tracker = new ChargingTracker();
      staleReplayEvents = tracker.reconcileProcess(latestProcess, new Date().toISOString()).length;
      if (staleReplayEvents !== 0) throw new Error("old completed charging process would be replayed");
    }
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  query_ms: queryMs,
  latest_process: status,
  completion_card_blocks: cardBlocks,
  stale_replay_events: staleReplayEvents
}, null, 2)}\n`);
