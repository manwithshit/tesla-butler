// Child process diagnostics never include SQL, arguments, stdout, or stderr.
export function createQueryRunner({ run, log = () => {}, now = Date.now }) {
  const failures = new Map();
  return async (file, args, options, name = 'query') => {
    const started = now();
    let phase = 'process';
    try {
      const { stdout } = await run(file, args, options);
      phase = 'parse';
      const value = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      const previous = failures.get(name) || 0;
      failures.set(name, 0);
      const duration = now() - started;
      if (previous || duration >= 1_000) log({ name, status: previous ? 'recovered' : 'slow', duration_ms: duration, failures: 0 });
      return value;
    } catch (error) {
      const code = phase === 'parse' ? 'DB_INVALID_JSON'
        : error?.name === 'AbortError' ? 'DB_ABORTED'
        : error?.killed || error?.code === 'ETIMEDOUT' ? 'DB_PROCESS_TIMEOUT'
        : /statement timeout/i.test(error?.stderr || '') ? 'DB_STATEMENT_TIMEOUT'
        : 'DB_PROCESS_FAILED';
      const count = (failures.get(name) || 0) + 1;
      failures.set(name, count);
      log({ name, status: 'failed', code, duration_ms: now() - started, failures: count });
      throw Object.assign(new Error(`${name} failed (${code})`), { code });
    }
  };
}

export async function withQueryDeadline(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'DB_DEADLINE' }));
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}
