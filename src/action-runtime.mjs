import { setTimeout as delay } from 'node:timers/promises';
import { safeErrorCode } from './worker-runtime.mjs';

// Only read/query actions enter here. Receipt and pricing mutations keep their
// own commit/feedback handling and must not be blindly replayed.
export async function runUserAction(action, context, { execute, notify, wait = delay, log = () => {} }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await execute(action, context);
      return { status: 'success' };
    } catch (error) {
      log(`action_retry attempt=${attempt} code=${safeErrorCode(error)}`);
      if (attempt === 1) await wait(500);
    }
  }
  await notify('这次查询暂时没有成功，请稍后重新发送或点击一次。');
  return { status: 'failed_with_feedback' };
}
