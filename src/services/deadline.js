export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  lockMs: 10_000,
  searchMs: 10_000,
  fetchMs: 20_000,
  parseMs: 5_000,
  logoutMs: 2_000,
  preflightMs: 8_000,
  modelMs: 90_000,
  messageMs: 90_000,
  runMs: 180_000,
});

export function resolveTimeouts(env = process.env) {
  return Object.fromEntries(Object.entries(DEFAULT_TIMEOUTS).map(([key, fallback]) => {
    const name = `SYNC_${key.replace(/Ms$/, '').toUpperCase()}_TIMEOUT_MS`;
    const value = Number(env[name]);
    return [key, Number.isInteger(value) && value > 0 ? Math.min(value, 600_000) : fallback];
  }));
}

export function deadlineError(code, label, timeoutMs) {
  return Object.assign(new Error(`${label}超过 ${timeoutMs / 1000} 秒上限`), { code });
}

// Race the entire operation, including reading its response body. Aborting a fetch
// signal alone cannot bound an injected transport/parser that ignores that signal.
export async function withDeadline(operation, { timeoutMs, signal, code, label }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forward, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason || Object.assign(new Error('同步已取消'), { code: 'SYNC_CANCELLED' }));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(deadlineError(code, label, timeoutMs)), timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
