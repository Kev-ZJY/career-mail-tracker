import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createSyncService } from '../src/services/sync-service.js';
import { createApi } from '../src/api.js';
import { createImapSource } from '../src/services/imap-source.js';
import { createLlmClassifier } from '../src/services/llm-service.js';

const window = { accountId: 'candidate@test', from: '2026-08-01', to: '2026-08-31T23:59:59Z' };
const analysis = { isJobRelated: true, company: '示例科技', position: '工程师', status: '已投递', confidence: .9, evidence: '已收到申请', nextAction: '等待通知', needsReview: false };
const mail = (uid) => ({ uid: String(uid), messageId: `<${uid}@test>`, receivedAt: `2026-08-0${uid}T08:00:00Z`, subject: '申请确认', text: '已收到您的申请', sender: 'hr@example.test' });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const stall = () => new Promise(() => {});

test('legacy sync history survives migration without inventing deferred counts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-migration-'));
  const path = join(directory, 'fixture.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY, account_id TEXT, from_date TEXT, to_date TEXT,
    inserted_count INTEGER, analyzed_count INTEGER, skipped_count INTEGER, created_at TEXT
  ); INSERT INTO sync_runs VALUES (1, 'legacy@test', '2026-08-01', '2026-08-31', 2, 3, 4, '2026-08-31');`);
  legacy.close();
  const database = createDatabase(path);
  try {
    const run = createMessageRepository(database.db).listSyncRuns()[0];
    assert.equal(run.analyzed, 3);
    assert.equal(run.inserted, 2);
    assert.equal(run.remaining, null);
    assert.equal(run.total, null);
    assert.equal(run.stopReason, null);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the first mail is committed while a later classification is still pending', async () => {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const later = deferred();
  const committed = deferred();
  const service = createSyncService({ repository, analysisVersion: 'stream-test', concurrency: 2, classifier: async ({ subject }) => subject === 'later' ? later.promise : analysis });
  const running = service.syncMessages({ ...window, messages: [mail(1), { ...mail(2), subject: 'later' }], onProgress: (event) => { if (event.changed) committed.resolve(); } });
  try {
    await Promise.race([committed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no incremental commit')), 150))]);
    assert.equal(repository.listAnalyses({ jobRelatedOnly: false }).length, 1);
  } finally { later.resolve(analysis); await running; database.close(); }
});

test('out-of-order model responses still commit in mail chronology', async () => {
  const database = createDatabase(':memory:');
  const first = deferred();
  const completed = deferred();
  const dates = [];
  const service = createSyncService({ repository: createMessageRepository(database.db), analysisVersion: 'stream-test', concurrency: 2,
    classifier: async ({ receivedAt }) => { if (receivedAt === mail(1).receivedAt) return first.promise; completed.resolve(); return analysis; } });
  const running = service.syncMessages({ ...window, messages: [mail(2), mail(1)], onProgress: (event) => { if (event.changed) dates.push(event.receivedAt); } });
  await completed.promise;
  assert.equal(dates.length, 0);
  first.resolve(analysis);
  await running;
  assert.deepEqual(dates, [new Date(mail(1).receivedAt).toISOString(), new Date(mail(2).receivedAt).toISOString()]);
  database.close();
});

test('a hung classifier has a whole-mail deadline and later mail still commits', async () => {
  const database = createDatabase(':memory:');
  let calls = 0;
  const service = createSyncService({ repository: createMessageRepository(database.db), analysisVersion: 'stream-test', concurrency: 1, messageTimeoutMs: 20,
    classifier: async () => { calls += 1; return calls === 1 ? stall() : analysis; } });
  try {
    const summary = await service.syncMessages({ ...window, messages: [mail(1), mail(2)] });
    assert.equal(summary.modelFailed, 1);
    assert.equal(summary.failures[0].error, 'MODEL_TIMEOUT');
    assert.equal(summary.inserted, 1);
    assert.equal(calls, 2);
  } finally { database.close(); }
});

test('rate limiting keeps already completed results and records the earliest deferred mail', async () => {
  const database = createDatabase(':memory:');
  const service = createSyncService({ repository: createMessageRepository(database.db), analysisVersion: 'stream-test', concurrency: 2,
    classifier: async ({ receivedAt }) => { if (receivedAt === mail(1).receivedAt) throw Object.assign(new Error('limited'), { code: 'MODEL_RATE_LIMITED' }); return analysis; } });
  try {
    const summary = await service.syncMessages({ ...window, messages: [mail(1), mail(2), mail(3)] });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.remaining, 1);
    assert.equal(summary.retryFrom, new Date(mail(1).receivedAt).toISOString());
    assert.equal(summary.stopReason, 'MODEL_RATE_LIMITED');
  } finally { database.close(); }
});

test('cancellation preserves committed mail and leaves the rest retryable', async () => {
  const database = createDatabase(':memory:');
  const controller = new AbortController();
  let calls = 0;
  const service = createSyncService({ repository: createMessageRepository(database.db), analysisVersion: 'stream-test', concurrency: 1, classifier: async () => { calls += 1; return analysis; } });
  try {
    const summary = await service.syncMessages({ ...window, signal: controller.signal, messages: [mail(1), mail(2)], onProgress: (event) => { if (event.changed) controller.abort(Object.assign(new Error('cancelled'), { code: 'SYNC_CANCELLED' })); } });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.remaining, 1);
    assert.equal(summary.stopReason, 'SYNC_CANCELLED');
    assert.equal(summary.retryFrom, new Date(mail(2).receivedAt).toISOString());
    assert.equal(calls, 1);
  } finally { database.close(); }
});

test('preflight happens after prescreen and is skipped when no mail needs a model', async () => {
  const database = createDatabase(':memory:');
  const stages = [];
  let checks = 0;
  const service = createSyncService({ repository: createMessageRepository(database.db), analysisVersion: 'stream-test', classifier: async () => analysis });
  try {
    await service.syncMessages({ ...window, messages: [mail(1)], preflight: async () => { checks += 1; assert.ok(stages.includes('prescreen')); }, onProgress: (event) => stages.push(event.stage) });
    await service.syncMessages({ ...window, messages: [mail(1)], preflight: async () => { checks += 1; } });
    assert.equal(checks, 1);
  } finally { database.close(); }
});

test('duplicate copies within one batch are analyzed and persisted once', async () => {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const service = createSyncService({ repository, analysisVersion: 'stream-test', classifier: async () => { calls += 1; return analysis; } });
  try {
    const summary = await service.syncMessages({ ...window, messages: [mail(1), mail(1)] });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(calls, 1);
    assert.equal(repository.listThreads({}).length, 1);
  } finally { database.close(); }
});

test('IMAP connection and logout deadlines close a hung client', async () => {
  let closed = false;
  const source = createImapSource({ timeouts: { connectMs: 20, logoutMs: 10 }, env: {}, clientFactory: async () => ({ connect: stall, logout: stall, close: () => { closed = true; } }) });
  await assert.rejects(source.fetchMessages({ provider: 'qq', email: 'a@qq.com', authorizationCode: 'auth', from: window.from, to: window.to }), { code: 'IMAP_CONNECT_TIMEOUT' });
  assert.equal(closed, true);
});

test('model timeout covers a hung response body as well as fetch headers', async () => {
  const classifier = createLlmClassifier({ provider: { id: 'ollama', baseUrl: 'http://model.test/v1', model: 'stub' }, timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, json: stall }) });
  await assert.rejects(classifier.classify(mail(1)), { code: 'MODEL_TIMEOUT' });
});

test('a failed preflight never analyzes or writes mail', async () => {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const service = createSyncService({ repository, analysisVersion: 'stream-test', preflightTimeoutMs: 20, classifier: async () => { calls += 1; return analysis; } });
  try {
    await assert.rejects(service.syncMessages({ ...window, messages: [mail(1)], preflight: stall }), { code: 'MODEL_PREFLIGHT_TIMEOUT' });
    assert.equal(calls, 0);
    assert.equal(repository.listThreads({}).length, 0);
  } finally { database.close(); }
});

test('the model probe uses the configured generation endpoint without sending mail or history', async () => {
  let request;
  const classifier = createLlmClassifier({ provider: { id: 'ollama', baseUrl: 'http://model.test/v1', model: 'stub' }, fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  } });
  assert.deepEqual(await classifier.checkConnection(), { ok: true });
  assert.equal(request.url, 'http://model.test/v1/chat/completions');
  assert.equal(request.body.model, 'stub');
  assert.doesNotMatch(JSON.stringify(request.body), /邮件接收时间|openThreads/);
});

test('the production IMAP iterator emits read progress before the last body arrives', async () => {
  const later = deferred();
  const firstRead = deferred();
  const events = [];
  const source = createImapSource({ env: {}, clientFactory: async () => ({
    mailbox: { uidValidity: 1 }, connect: async () => {}, getMailboxLock: async () => ({ release() {} }), search: async () => [1, 2], logout: async () => {},
    async *fetch() { yield { uid: 1, source: 'one' }; await later.promise; yield { uid: 2, source: 'two' }; },
  }), parser: async (text) => ({ date: mail(1).receivedAt, messageId: text, text: '已收到申请' }) });
  const running = source.fetchMessages({ provider: 'qq', email: 'a@qq.com', authorizationCode: 'auth', from: window.from, to: window.to, onProgress: (event) => { events.push(event); if (event.stage === 'fetching' && event.completed === 1) firstRead.resolve(); } });
  try {
    await firstRead.promise;
    assert.equal(events.at(-1).completed, 1);
    assert.equal(events.at(-1).total, 2);
  } finally { later.resolve(); assert.equal((await running).length, 2); }
});

for (const [name, method, key, code] of [
  ['lock', 'getMailboxLock', 'lockMs', 'IMAP_LOCK_TIMEOUT'],
  ['search', 'search', 'searchMs', 'IMAP_SEARCH_TIMEOUT'],
  ['fetch', 'fetchAll', 'fetchMs', 'IMAP_FETCH_TIMEOUT'],
  ['parser', 'parser', 'parseMs', 'MAIL_PARSE_TIMEOUT'],
]) {
  test(`a hung IMAP ${name} step is bounded and closes its client`, async () => {
    let closed = false;
    const client = { mailbox: {}, connect: async () => {}, getMailboxLock: async () => ({ release() {} }), search: async () => [1], fetchAll: async () => [{ uid: 1, source: 'raw' }], logout: async () => {}, close: () => { closed = true; } };
    if (method !== 'parser') client[method] = stall;
    const source = createImapSource({ env: {}, timeouts: { [key]: 20 }, clientFactory: async () => client, parser: method === 'parser' ? stall : async () => ({ date: mail(1).receivedAt, text: '' }) });
    await assert.rejects(source.fetchMessages({ provider: 'qq', email: 'a@qq.com', authorizationCode: 'auth', from: window.from, to: window.to }), { code });
    assert.equal(closed, true);
  });
}

test('the overall run deadline preserves earlier commits and holds the watermark before deferred mail', async () => {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const service = createSyncService({ repository, analysisVersion: 'stream-test', concurrency: 1 });
  const handler = createApi({ config: { port: 0, syncTimeouts: { runMs: 40 } }, repository, syncService: service,
    settingsService: { getMailboxConnection: () => ({ provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'auth' }) },
    imapSource: { fetchMessages: async () => [mail(1), mail(2), mail(3)] },
    createClassifier: async () => ({ classify: async ({ receivedAt }) => receivedAt === mail(1).receivedAt ? analysis : stall() }) });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: window.from, to: window.to }) });
    const summary = await response.json();
    assert.equal(summary.stopReason, 'SYNC_RUN_TIMEOUT');
    assert.equal(summary.analyzed, 1);
    assert.equal(summary.remaining, 2);
    assert.equal(repository.getSetting('sync.watermark.candidate@qq.com'), new Date(Date.parse(mail(2).receivedAt) - 1).toISOString());
    assert.equal(repository.listAnalyses({ jobRelatedOnly: false }).length, 1);
    const run = repository.listSyncRuns()[0];
    assert.equal(run.stopReason, 'SYNC_RUN_TIMEOUT');
    assert.equal(run.remaining, 2);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); database.close(); }
});

test('stream API publishes commits before completion, rejects concurrent runs, and keeps JSON compatibility', async () => {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const later = deferred();
  const service = createSyncService({ repository, analysisVersion: 'stream-test', concurrency: 2 });
  const handler = createApi({ config: { port: 0 }, repository, syncService: service,
    settingsService: { getMailboxConnection: () => ({ provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'hidden-auth' }) },
    imapSource: { fetchMessages: async () => [mail(1), mail(2)] },
    createClassifier: async () => ({ checkConnection: async () => {}, classify: async ({ receivedAt }) => receivedAt === mail(2).receivedAt ? later.promise : analysis }) });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/sync/run`;
  const request = (stream) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: window.from, to: window.to, stream }) });
  let reader;
  try {
    const response = await request(true);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    reader = response.body.getReader();
    let text = '';
    while (!text.includes('"changed":true')) { const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value); }
    assert.equal(repository.listThreads({}).length, 1);
    const busy = await request(false);
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'SYNC_IN_PROGRESS');
    later.resolve(analysis);
    while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    const events = text.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'complete');
    assert.equal(events.at(-1).summary.analyzed, 2);
    assert.equal(text.includes('hidden-auth'), false);
    const json = await request(false);
    assert.equal(json.status, 200);
    assert.equal((await json.json()).skipped, 2);
  } finally { later.resolve(analysis); await reader?.cancel(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); database.close(); }
});
