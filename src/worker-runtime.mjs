export function createSerialQueue() {
  let tail = Promise.resolve();
  let size = 0;
  const keyed = new Map();
  return {
    get size() { return size; },
    drain: () => tail,
    enqueue(operation, key) {
      if (key && keyed.has(key)) return keyed.get(key);
      size++;
      const queued = tail.then(operation).finally(() => {
        size--;
        if (key) keyed.delete(key);
      });
      tail = queued.catch(() => {});
      if (key) keyed.set(key, queued);
      return queued;
    }
  };
}

export function createEventProcessor({ limit = 2_000 } = {}) {
  const completed = new Set();
  const active = new Map();
  const process = (key, handler) => {
    if (!key) return Promise.resolve({ status: 'missing_key' });
    if (completed.has(key)) return Promise.resolve({ status: 'duplicate' });
    if (active.has(key)) return active.get(key);
    const operation = Promise.resolve().then(handler).then(result => {
      completed.add(key);
      if (completed.size > limit) completed.delete(completed.values().next().value);
      return result;
    }).finally(() => active.delete(key));
    active.set(key, operation);
    return operation;
  };
  process.drain = () => Promise.allSettled([...active.values()]);
  Object.defineProperty(process, 'size', { get: () => active.size });
  return process;
}

export function safeErrorCode(error) {
  const code = String(error?.code || error?.name || 'UNKNOWN');
  return /^[A-Za-z0-9_]{1,50}$/.test(code) ? code : 'UNKNOWN';
}
