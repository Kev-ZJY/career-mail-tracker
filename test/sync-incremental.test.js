import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createImapSource } from '../src/services/imap-source.js';
import { createSyncService } from '../src/services/sync-service.js';
import { imapReceiptScope } from '../src/services/imap-receipts.js';

const window = { from: '2026-08-20T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' };
const accountId = 'candidate@qq.com';
const mailbox = { provider: 'qq', email: accountId, authorizationCode: 'fixture-auth' };
const candidate = (uid, changes = {}) => ({
  uid, date: '2026-08-21T08:30:00.000Z', messageId: `<${uid}@example.test>`,
  subject: '示例科技面试邀请', text: `我们邀请你参加技术面试，邮件 ${uid}。`, ...changes,
});
const ignored = (uid) => candidate(uid, { subject: '验证码', text: '请验证你的登录请求。' });
const analysis = {
  isJobRelated: true, company: '示例科技', position: '后端开发工程师', status: '面试',
  confidence: 0.9, evidence: '邀请参加技术面试', nextAction: '确认面试时间', needsReview: false,
};

function harness({ mails = [candidate(1), ignored(2)], classify, databasePath = ':memory:' } = {}) {
  const database = createDatabase(databasePath);
  const repository = createMessageRepository(database.db);
  const state = { mails, validity: 77, fetchCalls: [], parsed: 0, modelCalls: 0, probes: 0, delivered: null };
  const model = {
    classify: async (message) => { state.modelCalls += 1; return classify ? classify(message, state) : analysis; },
    checkConnection: async () => { state.probes += 1; return { ok: true }; },
  };
  const service = (version = 'fixture-v1') => createSyncService({ repository, analysisVersion: version, classifier: model, concurrency: 1 });
  const source = (version = 'fixture-v1') => createImapSource({ repository, analysisVersion: version, env: {},
    clientFactory: () => ({
      mailbox: { uidValidity: state.validity }, connect: async () => {}, logout: async () => {},
      getMailboxLock: async () => ({ release() {} }),
      search: async () => state.mails.map((mail) => mail.uid),
      async *fetch(uids, query, options) {
        state.fetchCalls.push([...uids]);
        assert.equal(query.source, true);
        assert.equal(options.uid, true);
        for (const uid of uids) {
          if (state.delivered && !state.delivered.includes(uid)) continue;
          yield { uid, source: state.mails.find((mail) => mail.uid === uid) };
        }
      },
    }),
    parser: async (mail) => { state.parsed += 1; return mail; },
  });
  const run = async (options = {}) => {
    const { version = 'fixture-v1', email = mailbox.email, provider = mailbox.provider, ...overrides } = options;
    const args = { ...window, accountId, ...overrides };
    let sourceStats;
    const messages = await source(version).fetchMessages({ ...mailbox, ...args, email, provider,
      onSelection: (stats) => { sourceStats = stats; } });
    return service(version).syncMessages({ ...args, messages, mailboxEmail: email, sourceStats,
      preflight: (signal) => model.checkConnection({ signal }) });
  };
  return { database, repository, state, source, service, model, run };
}

test('repeating a completed date window performs SEARCH but no body reads, parsing, probes, models or archive updates', async () => {
  const f = harness({ mails: [candidate(1), ignored(2), candidate(3, { date: '2026-08-19T12:00:00.000Z' })] });
  try {
    const first = await f.run();
    assert.equal(first.analyzed, 1);
    assert.equal(first.ignored, 1);
    assert.equal(first.sourceFetched, 3);
    const archivedBefore = f.database.db.prepare('SELECT * FROM mail_messages').all();
    const threadsBefore = f.repository.listThreads();
    const events = [];
    const second = await f.run({ onProgress: (event) => events.push(event) });
    assert.equal(second.sourceSearched, 3);
    assert.equal(second.sourceCached, 3);
    assert.equal(second.sourceFetched, 0);
    assert.equal(second.sourceDeferred, 0);
    assert.equal(second.analyzed, 0);
    assert.equal(second.ignored, 0);
    assert.ok(events.some((event) => event.stage === 'fetching' && event.total === 0 && event.sourceCached === 3));
    assert.deepEqual(f.state.fetchCalls, [[1, 2, 3]]);
    assert.equal(f.state.parsed, 3);
    assert.equal(f.state.modelCalls, 1);
    assert.equal(f.state.probes, 1);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM mail_messages').all(), archivedBefore);
    assert.deepEqual(f.repository.listThreads(), threadsBefore);
    assert.equal(f.repository.listSyncRuns()[0].sourceCached, 3);
    const expanded = await f.run({ from: '2026-08-19T00:00:00.000Z' });
    assert.equal(expanded.sourceCached, 2);
    assert.equal(expanded.sourceFetched, 1);
    assert.equal(expanded.inserted, 1, 'a padded-day receipt must be reconsidered inside a wider window');
  } finally { f.database.close(); }
});

test('new UIDs with old dates and reused Message-IDs still fetch and preserve distinct original mails', async () => {
  const f = harness({ mails: [candidate(1)] });
  try {
    await f.run();
    f.state.mails.push(candidate(2, { messageId: '<1@example.test>', date: '2026-08-20T01:00:00.000Z', text: '另一封个人招聘面试通知。' }));
    const result = await f.run();
    assert.equal(result.sourceCached, 1);
    assert.equal(result.sourceFetched, 1);
    assert.equal(result.inserted, 1);
    assert.deepEqual(f.state.fetchCalls, [[1], [2]]);
    assert.equal(f.repository.listAnalyses({ jobRelatedOnly: false }).length, 2);
    assert.equal((await f.run()).sourceFetched, 0);
  } finally { f.database.close(); }
});

test('failed and undispatched mails stay retryable while successful and ignored UIDs are cached', async () => {
  let unavailable = true;
  const f = harness({ mails: [candidate(1), candidate(2), candidate(3), ignored(4)], classify: (message) => {
    if (unavailable && message.text.includes('邮件 2。')) throw Object.assign(new Error('limited'), { code: 'MODEL_RATE_LIMITED' });
    return analysis;
  } });
  try {
    const first = await f.run();
    assert.equal(first.analyzed, 1);
    assert.equal(first.modelFailed, 1);
    assert.equal(first.remaining, 1);
    unavailable = false;
    const retry = await f.run();
    assert.equal(retry.sourceCached, 2);
    assert.equal(retry.sourceFetched, 2);
    assert.equal(retry.analyzed, 2);
    assert.deepEqual(f.state.fetchCalls, [[1, 2, 3, 4], [2, 3]]);
    assert.equal((await f.run()).sourceFetched, 0);
  } finally { f.database.close(); }
});

test('cancellation only acknowledges committed results and retry reads the remaining UID', async () => {
  const f = harness({ mails: [candidate(1), candidate(2)] });
  const controller = new AbortController();
  try {
    const first = await f.run({ signal: controller.signal, onProgress: (event) => {
      if (event.changed) controller.abort(Object.assign(new Error('cancelled'), { code: 'SYNC_CANCELLED' }));
    } });
    assert.equal(first.analyzed, 1);
    assert.equal(first.remaining, 1);
    const retry = await f.run();
    assert.equal(retry.sourceCached, 1);
    assert.equal(retry.sourceFetched, 1);
    assert.equal(retry.analyzed, 1);
  } finally { f.database.close(); }
});

test('UIDVALIDITY, actual mailbox email, provider, account and extraction version isolate completion receipts', async () => {
  const f = harness();
  try {
    await f.run();
    assert.equal((await f.run()).sourceCached, 2);
    for (const overrides of [{ accountId: 'other' }, { email: 'other@qq.com' }, { provider: 'netease' }]) {
      assert.equal((await f.run(overrides)).sourceFetched, 2);
    }
    f.state.validity = 78;
    assert.equal((await f.run()).sourceFetched, 2);
    f.state.validity = undefined;
    assert.equal((await f.run()).sourceFetched, 2);
    assert.equal((await f.run()).sourceFetched, 2, 'unknown UIDVALIDITY must never be cached');
    f.state.validity = 77;
    const v2 = await f.run({ version: 'fixture-v2' });
    assert.equal(v2.sourceFetched, 2);
    assert.equal(v2.analyzed, 1);
    assert.equal(v2.ignored, 1);
    const inbox = imapReceiptScope({ ...mailbox, accountId, uidValidity: 77, analysisVersion: 'fixture-v2' });
    assert.equal(f.repository.getCompletedImapUids({ ...inbox, folder: 'Archive' }, window).size, 0);
  } finally { f.database.close(); }
});

test('fallback archive keys preserve distinct actual mailboxes and providers sharing a logical account and UID', async () => {
  const f = harness({ mails: [candidate(1, { messageId: '', text: 'fixture A：请参加技术面试。' })] });
  const logicalAccount = 'logical-account';
  const identities = [
    { accountId: logicalAccount, email: 'fixture-a@qq.com', provider: 'qq' },
    { accountId: logicalAccount, email: 'fixture-b@qq.com', provider: 'qq' },
    { accountId: logicalAccount, email: 'fixture-a@qq.com', provider: 'netease' },
  ];
  try {
    for (const [index, identity] of identities.entries()) {
      f.state.mails[0].text = `fixture ${index}：请参加技术面试。`;
      const result = await f.run(identity);
      assert.equal(result.inserted, 1);
      assert.equal(result.sourceFetched, 1);
    }
    const archives = f.database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();
    assert.equal(archives.length, 3);
    assert.equal(new Set(archives.map((row) => row.message_key)).size, 3);
    assert.deepEqual(archives.map((row) => row.body_text), identities.map((_, index) => `fixture ${index}：请参加技术面试。`));
    for (const identity of identities) assert.equal((await f.run(identity)).sourceCached, 1);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all(), archives);
  } finally { f.database.close(); }
});

test('reused Message-ID archive suffixes include the actual mailbox while preserving ordinary Message-ID keys', async () => {
  const f = harness({ mails: [candidate(1, { text: 'fixture A：请参加技术面试。' })] });
  try {
    const logicalAccount = 'logical-account';
    await f.run({ accountId: logicalAccount, email: 'fixture-a@qq.com' });
    const first = f.database.db.prepare('SELECT * FROM mail_messages').get();
    assert.equal(first.message_key, `${logicalAccount}|message-id|<1@example.test>`);
    f.state.mails[0].text = 'fixture B：请参加另一场技术面试。';
    await f.run({ accountId: logicalAccount, email: 'fixture-b@qq.com' });
    f.state.mails[0].text = 'fixture C：请参加新的技术面试。';
    await f.run({ accountId: logicalAccount, email: 'fixture-c@qq.com' });
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count, 3);
    assert.deepEqual(f.repository.findByKey(first.message_key), first);
    for (const email of ['fixture-a@qq.com', 'fixture-b@qq.com', 'fixture-c@qq.com']) {
      assert.equal((await f.run({ accountId: logicalAccount, email })).sourceCached, 1);
    }
  } finally { f.database.close(); }
});

test('legacy fallback and collision keys warm without renaming only when their existing mailbox origin is identifiable', async () => {
  for (const messageId of ['', '<reused@example.test>']) {
    const f = harness({ mails: [candidate(1, { messageId, text: 'fixture A：请参加技术面试。' })] });
    try {
      if (messageId) {
        f.state.mails.unshift(candidate(2, { messageId, text: 'fixture B：另一封技术面试通知。', date: '2026-08-20T08:00:00.000Z' }));
      }
      await f.run();
      const row = f.database.db.prepare('SELECT * FROM mail_messages WHERE body_text LIKE ?').get('fixture A%');
      const legacyKey = messageId ? `${accountId}|message-id|${messageId}|imap|${accountId}|INBOX|77|1` : `${accountId}|INBOX|77|1`;
      f.database.db.prepare('UPDATE mail_messages SET message_key = ? WHERE id = ?').run(legacyKey, row.id);
      f.database.db.exec('DELETE FROM imap_completion_receipts');
      const before = f.database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();
      f.state.modelCalls = 0;
      const warm = await f.run();
      assert.equal(warm.analyzed, 0);
      assert.equal(f.state.modelCalls, 0);
      assert.equal(warm.skipped, f.state.mails.length);
      assert.deepEqual(f.database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all(), before);
      assert.equal((await f.run()).sourceCached, f.state.mails.length);
    } finally { f.database.close(); }
  }
});

test('legacy logical aliases without actual mailbox evidence cannot overwrite fallback or collision archives', async () => {
  for (const messageId of ['', '<reused@example.test>']) {
    const f = harness({ mails: [candidate(1, { messageId, text: 'fixture A：请参加技术面试。' })] });
    try {
      const logicalAccount = 'logical-account';
      if (messageId) f.state.mails.unshift(candidate(2, { messageId, text: 'fixture primary：请参加技术面试。', date: '2026-08-20T08:00:00.000Z' }));
      await f.run({ accountId: logicalAccount, email: 'fixture-a@qq.com' });
      const row = f.database.db.prepare('SELECT * FROM mail_messages WHERE body_text LIKE ?').get('fixture A%');
      const legacyKey = messageId ? `${logicalAccount}|message-id|${messageId}|imap|${logicalAccount}|INBOX|77|1` : `${logicalAccount}|INBOX|77|1`;
      f.database.db.prepare('UPDATE mail_messages SET message_key = ? WHERE id = ?').run(legacyKey, row.id);
      f.database.db.exec('DELETE FROM imap_completion_receipts');
      const original = f.repository.findByKey(legacyKey);
      f.state.mails.find((mail) => mail.uid === 1).text = 'fixture B：请参加另一场技术面试。';
      const result = await f.run({ accountId: logicalAccount, email: 'fixture-b@qq.com' });
      assert.equal(result.inserted, 1);
      assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count, f.state.mails.length + 1);
      assert.deepEqual(f.repository.findByKey(legacyKey), original);
      assert.equal((await f.run({ accountId: logicalAccount, email: 'fixture-b@qq.com' })).sourceCached, f.state.mails.length);
    } finally { f.database.close(); }
  }
});

test('dry runs preserve full-window counts and never create receipts, runs or watermark changes', async () => {
  const f = harness();
  try {
    const dry = await f.run({ dryRun: true });
    assert.equal(dry.candidates, 1);
    assert.equal(dry.ignored, 1);
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM imap_completion_receipts').get().count, 0);
    assert.equal(f.repository.listSyncRuns().length, 0);
    await f.run();
    const before = f.database.db.prepare('SELECT * FROM imap_completion_receipts').all();
    assert.equal((await f.run({ dryRun: true })).sourceFetched, 2);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM imap_completion_receipts').all(), before);
    assert.equal(f.state.modelCalls, 1);
  } finally { f.database.close(); }
});

test('deleting a mail archive or its application route invalidates receipts and restores the missing result', async () => {
  const f = harness({ mails: [candidate(1)] });
  try {
    await f.run();
    const thread = f.repository.listThreads()[0];
    f.repository.deleteThreadByIds([thread.id]);
    const route = await f.run();
    assert.equal(route.sourceFetched, 1);
    assert.equal(route.analyzed, 1);
    assert.equal(f.repository.listThreads().length, 1);
    const row = f.repository.listAnalyses()[0];
    f.repository.deleteByIds([row.id]);
    const archive = await f.run();
    assert.equal(archive.sourceFetched, 1);
    assert.equal(archive.inserted, 1);
  } finally { f.database.close(); }
});

test('a successful non-job model result is cached without requiring an application route', async () => {
  const f = harness({ mails: [candidate(1)], classify: () => ({ ...analysis, isJobRelated: false, status: '已结束' }) });
  try {
    await f.run();
    assert.equal(f.repository.listThreads().length, 0);
    assert.equal((await f.run()).sourceCached, 1);
  } finally { f.database.close(); }
});

test('same-run duplicates are acknowledged together only after a successful shared analysis', async () => {
  let unavailable = true;
  const f = harness({ mails: [candidate(1), candidate(2, { messageId: '<1@example.test>', text: candidate(1).text })], classify: () => {
    if (unavailable) throw Object.assign(new Error('limited'), { code: 'MODEL_RATE_LIMITED' });
    return analysis;
  } });
  try {
    await f.run();
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM imap_completion_receipts').get().count, 0);
    unavailable = false;
    const retry = await f.run();
    assert.equal(retry.analyzed, 1);
    assert.equal(retry.skipped, 1);
    assert.equal((await f.run()).sourceCached, 2);
  } finally { f.database.close(); }
});

test('receipts survive database reopen and legacy rows warm once without hash rewrites or model calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-incremental-'));
  const databasePath = join(directory, 'fixture.sqlite');
  let f = harness({ databasePath });
  try {
    await f.run();
    // Historical archives can be shortened independently of their original
    // fingerprints. Warmup must compare the live source, never rewrite hashes
    // from the archived text just to establish a source receipt.
    f.database.db.prepare('UPDATE mail_messages SET body_text = ?').run('短存档正文');
    const archivedBefore = f.database.db.prepare('SELECT * FROM mail_messages').all();
    f.database.db.exec('DROP TABLE imap_completion_receipts');
    f.database.close();
    f = harness({ databasePath });
    const warm = await f.run();
    assert.equal(warm.sourceFetched, 2);
    assert.equal(warm.skipped, 1);
    assert.equal(f.state.modelCalls, 0);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM mail_messages').all(), archivedBefore);
    f.database.close();
    f = harness({ databasePath });
    assert.equal((await f.run()).sourceCached, 2);
    assert.deepEqual(f.state.fetchCalls, []);
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('source-deferred counts include invalid dates and disappearing UIDs rather than acknowledging them', async () => {
  const f = harness({ mails: [candidate(1), candidate(2, { date: 'invalid' }), candidate(3)] });
  f.state.delivered = [1, 2];
  try {
    const first = await f.run();
    assert.equal(first.sourceFetched, 2);
    assert.equal(first.sourceDeferred, 2);
    f.state.delivered = null;
    f.state.mails[1].date = candidate(2).date;
    const retry = await f.run();
    assert.equal(retry.sourceCached, 1);
    assert.equal(retry.sourceFetched, 2);
    assert.equal(retry.analyzed, 2);
  } finally { f.database.close(); }
});

test('manual API requests use UID receipts and maxMessages limits uncached work with a conservative watermark', async () => {
  const f = harness({ mails: [candidate(1), ignored(2), candidate(3)] });
  const config = { port: 0, analysisVersion: 'fixture-v1' };
  const handler = createApi({ config, repository: f.repository, settingsService: { getMailboxConnection: () => mailbox },
    syncService: f.service(), imapSource: f.source(), createClassifier: async () => f.model });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const request = async (extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/sync/run`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...window, ...extra }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await request({ maxMessages: 1 });
    assert.equal(first.sourceFetched, 1);
    assert.equal(first.sourceDeferred, 2);
    assert.equal(f.repository.getSetting(`sync.watermark.${accountId}`), window.from);
    const second = await request({ maxMessages: 1 });
    assert.equal(second.sourceCached, 1);
    assert.equal(second.sourceDeferred, 1);
    const third = await request({ maxMessages: 1 });
    assert.equal(third.sourceCached, 2);
    assert.equal(third.sourceDeferred, 0);
    assert.equal(f.repository.getSetting(`sync.watermark.${accountId}`), window.to);
    const repeated = await request();
    assert.equal(repeated.sourceCached, 3);
    assert.equal(repeated.sourceFetched, 0);
    assert.equal(repeated.analyzed, 0);
    assert.equal(f.state.probes, 2);
    const dry = await request({ dryRun: true });
    assert.equal(dry.sourceFetched, 3);
    assert.equal(dry.candidates, 2);
    assert.equal(f.repository.getSetting(`sync.watermark.${accountId}`), window.to);
    const stream = await fetch(`http://127.0.0.1:${config.port}/api/sync/run`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...window, stream: true }) });
    assert.match(stream.headers.get('content-type'), /application\/x-ndjson/);
    const events = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'complete');
    assert.equal(events.at(-1).summary.sourceCached, 3);
    assert.equal(events.at(-1).summary.sourceFetched, 0);
    assert.equal(f.repository.listSyncRuns()[0].sourceCached, 3);
  } finally { await new Promise((resolve) => server.close(resolve)); f.database.close(); }
});
