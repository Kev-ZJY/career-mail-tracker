import test from 'node:test';
import assert from 'node:assert/strict';
import { readSyncStream } from '../public/sync-stream.js';

const response = (chunks) => new Response(new ReadableStream({ start(controller) { for (const text of chunks) controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });

test('the browser consumes split JSON and UTF-8 chunks and reports progress before completion', async () => {
  const bytes = new TextEncoder().encode('{"type":"progress","label":"邮箱连接中"}\n{"type":"complete","summary":{"inserted":1}}\n');
  const events = [];
  const summary = await readSyncStream({ body: {}, onEvent: (event) => events.push(event), fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 32)); controller.enqueue(bytes.slice(32, 35)); controller.enqueue(bytes.slice(35)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  assert.equal(events[0].label, '邮箱连接中');
  assert.equal(events[1].type, 'complete');
  assert.equal(summary.inserted, 1);
});

test('an error inside an HTTP 200 stream is still surfaced as an error', async () => {
  await assert.rejects(readSyncStream({ body: {}, fetchImpl: async () => response(['{"type":"error","code":"MODEL_PREFLIGHT_TIMEOUT","error":"模型连接超时"}\n']) }), { code: 'MODEL_PREFLIGHT_TIMEOUT' });
});

test('an ended stream without a terminal event never reports success', async () => {
  await assert.rejects(readSyncStream({ body: {}, fetchImpl: async () => response(['{"type":"progress"}\n']) }), { code: 'SYNC_STREAM_INTERRUPTED' });
});

test('a silent response body is cancelled after the browser idle deadline', async () => {
  await assert.rejects(readSyncStream({ body: {}, idleTimeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/x-ndjson' } }) }), { code: 'SYNC_STREAM_TIMEOUT' });
});

test('a header request ignoring AbortSignal is still bounded', async () => {
  await assert.rejects(readSyncStream({ body: {}, idleTimeoutMs: 20, fetchImpl: () => new Promise(() => {}) }), { code: 'SYNC_STREAM_TIMEOUT' });
});

test('user cancellation reaches the fetch signal and terminates stream reading', async () => {
  const controller = new AbortController();
  let reached = false;
  const running = readSyncStream({ body: {}, signal: controller.signal, fetchImpl: async (_url, options) => {
    options.signal.addEventListener('abort', () => { reached = true; });
    setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { code: 'SYNC_CANCELLED' })), 10);
    return new Response(new ReadableStream(), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  await assert.rejects(running, { code: 'SYNC_CANCELLED' });
  assert.equal(reached, true);
});
