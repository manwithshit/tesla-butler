import { safeErrorCode } from './worker-runtime.mjs';

const retryMs = 5 * 60_000;
const note = "<font color='grey'>底图暂不可用，已保留真实轨迹</font>";

export async function trackMapCardDelivery(card, metadata, response, dependencies) {
  if (!metadata) return { status: 'not_needed' };
  // A delivery has already succeeded. A repair registration error must never
  // cause a second user-visible send. Log only the safe aggregate result.
  try {
    const value = JSON.parse(response.stdout);
    if (value.ok === false || (value.code !== undefined && value.code !== 0)) throw new Error();
    const messageId = value.message_id || value.data?.message_id || value.result?.message_id;
    if (typeof messageId !== 'string' || !messageId) throw new Error();
    await dependencies.save(makeMapRepairJob({ ...metadata, card, messageId }, (dependencies.now || Date.now)()));
    return { status: 'scheduled' };
  } catch { return { status: 'failed' }; }
}

export async function patchSentMapCard(messageId, card, execute) {
  try {
    const { stdout } = await execute([
      'api', 'PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      '--data', JSON.stringify({ content: JSON.stringify(card) }), '--as', 'bot'
    ]);
    const result = JSON.parse(stdout);
    if (result.ok === false || (result.code !== undefined && result.code !== 0)
      || (result.code !== 0 && result.ok !== true)) throw new Error();
  } catch {
    const error = new Error('Feishu card update failed');
    error.code = 'FEISHU_CARD_UPDATE_FAILED';
    throw error;
  }
}

export function makeMapRepairJob({ messageId, card, cacheKey, segmentIds }, now = Date.now()) {
  return {
    message_id: messageId, card: structuredClone(card), cache_key: cacheKey,
    segment_ids: [...segmentIds], attempts: 0,
    next_attempt_at: now + retryMs, expires_at: now + 60 * 60_000
  };
}

export function createMapRepairProcessor(dependencies) {
  let active;
  const now = dependencies.now || Date.now;
  const log = dependencies.log || (() => {});
  async function tick() {
    const jobs = await dependencies.read();
    for (const [key, job] of Object.entries(jobs)) {
      if (now() >= job.expires_at || job.attempts >= 3) {
        await dependencies.save(key, null);
        log({ status: job.attempts >= 3 ? 'exhausted' : 'expired', attempt: job.attempts });
        continue;
      }
      if (now() < job.next_attempt_at) continue;
      // Persist the attempt before network IO: restarts cannot create a hot loop.
      const attempt = { ...job, attempts: job.attempts + 1, next_attempt_at: now() + retryMs };
      await dependencies.save(key, attempt);
      try {
        const image = await dependencies.resolve(job);
        if (image.imageKey && image.mapMeta?.hasBasemap) {
          const card = structuredClone(job.card);
          const index = card.body.elements.findIndex(item => item.tag === 'img');
          card.body.elements[index].img_key = image.imageKey;
          if (card.body.elements[index + 1]?.content === note) card.body.elements.splice(index + 1, 1);
          await dependencies.patch(job.message_id, card);
          await dependencies.save(key, null);
          log({ status: 'updated', attempt: attempt.attempts });
        } else log({ status: 'degraded', attempt: attempt.attempts });
      } catch (error) {
        log({ status: 'failed', attempt: attempt.attempts, code: safeErrorCode(error) });
      }
      // At most one network job per tick; do not monopolize this worker.
      break;
    }
  }
  return () => {
    if (!active) active = tick().finally(() => { active = null; });
    return active;
  };
}
