import { getTripInsightHistory } from "./teslamate.mjs";
import { buildTripInsightSessions, selectTripAdvice } from "./trip-insights.mjs";

const drives = await getTripInsightHistory();
const sessions = buildTripInsightSessions(drives);
const latest = sessions.at(-1);

if (drives.length === 0 || sessions.length === 0 || !latest) {
  throw new Error("trip insight history is unavailable");
}
if (!(latest.sample_coverage >= 0.9)) {
  throw new Error("latest trip samples are incomplete");
}

const advice = selectTripAdvice(latest, sessions);
if (advice && (!advice.code || !advice.title || !advice.detail || advice.baseline_count < 3)) {
  throw new Error("trip advice is incomplete");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  drive_count: drives.length,
  session_count: sessions.length,
  latest_segment_count: latest.segment_ids.length,
  latest_sample_coverage: latest.sample_coverage,
  advice_code: advice?.code || null,
  baseline_count: advice?.baseline_count || 0
})}\n`);
