function syncError(message, code) { return Object.assign(new Error(message), { code }); }

// Progress heartbeats keep the stream alive. A silent connection is bounded at
// both the response-header and response-body stages, even for custom transports.
export async function readSyncStream({ body, signal, onEvent = () => {}, fetchImpl = globalThis.fetch, url = '/api/sync/run', idleTimeoutMs = 15_000 }) {
  const controller = new AbortController();
  const cancelled = () => controller.abort(signal.reason || syncError('同步已取消，已写入的记录保留', 'SYNC_CANCELLED'));
  if (signal?.aborted) cancelled();
  signal?.addEventListener('abort', cancelled, { once: true });
  const bounded = async (operation) => {
    if (controller.signal.aborted) throw controller.signal.reason;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(syncError('同步连接长时间没有进度，已停止等待；已写入记录保留，可重新同步继续', 'SYNC_STREAM_TIMEOUT')), idleTimeoutMs);
    try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  };
  let reader;
  try {
    const response = await bounded(() => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: controller.signal }));
    if (!response.ok) {
      const error = await bounded(() => response.json());
      throw syncError(error.error || '同步请求失败', error.code || 'GENERIC');
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw syncError('同步接口没有返回进度流，请重启服务后重试', 'SYNC_STREAM_INVALID');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await bounded(() => reader.read());
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (done && buffer.trim()) { lines.push(buffer); buffer = ''; }
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        onEvent(event);
        if (event.type === 'error') throw syncError(event.error, event.code);
        if (event.type === 'complete') return event.summary;
      }
      if (done) throw syncError('同步连接已中断，已写入记录保留，可重新同步继续', 'SYNC_STREAM_INTERRUPTED');
    }
  } finally {
    signal?.removeEventListener('abort', cancelled);
    controller.abort();
    // Do not await cancellation: a broken custom reader must not hang cleanup.
    reader?.cancel().catch(() => {});
  }
}
