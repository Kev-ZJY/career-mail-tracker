import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { createSyncService } from '../src/services/sync-service.js';
import { buildProgressNotes } from '../src/domain/progress-notes.js';

const ACCOUNT = 'restructure@example.test';
const COMPANY = '申请重构测试公司';

async function fixture(run) {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const settingsService = createSettingsService({ repository, credentialStore: createCredentialStore() });
  settingsService.saveMailbox({ provider: 'qq', email: ACCOUNT });
  const config = { port: 0 };
  const server = http.createServer(createApi({ config, repository, settingsService }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: body ? method : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ database, repository, request }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    database.close();
  }
}

function mail(repository, key, {
  accountId = ACCOUNT, company = COMPANY, position = '岗位甲', status = '已投递',
  receivedAt = '2026-09-01T00:00:00.000Z', threadId,
} = {}) {
  const message = {
    messageKey: `restructure|${accountId}|${key}`,
    messageId: `<${key}@restructure.example.test>`,
    provider: 'qq', folder: 'INBOX', uidValidity: 'fixture-1', uid: key,
    receivedAt, sender: 'hr@restructure.example.test', subject: `${company} ${key} 进度通知`,
    text: `公司：${company}\n岗位：${position}\n原始邮件正文 ${key}`,
  };
  const analysis = { isJobRelated: true, company, position, status, confidence: .9,
    evidence: `原始证据 ${key}`, nextAction: '等待通知', needsReview: false };
  const saved = repository.saveAnalysis({ ...message, accountId,
    contentHash: `fixture-hash-${key}`, analysisVersion: 'restructure-v1',
    bodyText: message.text, bodyHtml: `<p>原始 HTML ${key}</p>`, analyzedAt: receivedAt, analysis });
  const id = Number(repository.upsertThreadFromMessage({ threadId, accountId, company, position, status,
    confidence: .9, needsReview: false, evidence: analysis.evidence, nextAction: analysis.nextAction,
    receivedAt, messageId: saved.id }));
  repository.linkMessageToThread(id, saved.id, receivedAt);
  return { id, messageId: saved.id, message, analysis };
}

function manual(repository, id, {
  company = COMPANY, position = '岗位甲', status = '面试', recordedAt = '2026-09-05T00:00:00.000Z',
} = {}) {
  repository.applyManualProgress({ threadId: id, company, position, status, receivedAt: recordedAt,
    eventStart: '2030-10-09T01:00:00.000Z', notes: 'https://meeting.example.test/restructure' });
  return repository.listManualProgress(id)[0];
}

function snapshot(database) {
  const tables = ['application_threads', 'application_thread_messages', 'mail_messages', 'manual_progress_events'];
  if (database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_message_routes'").get()) {
    tables.push('manual_message_routes');
  }
  if (database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_structure_events'").get()) {
    tables.push('application_structure_events');
  }
  return Object.fromEntries(tables.map(table => {
    const order = ['manual_message_routes', 'application_thread_messages'].includes(table) ? 'message_id,thread_id' : 'id';
    return [table, database.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()];
  }));
}

const ids = rows => rows.map(row => Number(row.id)).sort((a, b) => a - b);
const messageIds = (repository, threadId) => ids(repository.listThreadMessages(threadId));

test('merge preview exposes the complete proposal and optimistic versions without writing data', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'preview-target');
    const source = mail(repository, 'preview-source', { position: '岗位乙', status: '面试', receivedAt: '2026-09-03T00:00:00.000Z' });
    repository.linkMessageToThread(target.id, source.messageId);
    manual(repository, target.id);
    manual(repository, source.id, { position: '岗位乙', status: 'Offer', recordedAt: '2026-09-06T00:00:00.000Z' });
    const before = snapshot(database);
    const preview = await request(`/api/progress/merge-preview?targetId=${target.id}&sourceIds=${source.id}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.target.id, target.id);
    assert.deepEqual(ids(preview.body.sources), [source.id]);
    assert.equal(preview.body.emailCount, 2);
    assert.equal(preview.body.manualCount, 2);
    assert.ok(preview.body.proposed);
    assert.equal(preview.body.expectedUpdatedAt[target.id], repository.getThread(target.id).updatedAt);
    assert.equal(preview.body.expectedUpdatedAt[source.id], repository.getThread(source.id).updatedAt);
    assert.deepEqual(snapshot(database), before);
  });
});

test('email merge keeps archives, both manual histories and a recoverable soft source', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'history-target');
    const source = mail(repository, 'history-source', { position: '岗位乙', receivedAt: '2026-09-03T00:00:00.000Z' });
    const firstEvent = manual(repository, target.id);
    const secondEvent = manual(repository, source.id, { position: '岗位乙', status: 'Offer', recordedAt: '2026-09-06T00:00:00.000Z' });
    const archivedBefore = database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, target.id);
    assert.deepEqual(ids(repository.listThreads()), [target.id]);
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
    assert.deepEqual(messageIds(repository, target.id), [target.messageId, source.messageId].sort((a, b) => a - b));
    assert.deepEqual(messageIds(repository, source.id), []);
    assert.ok(repository.listManualProgress(target.id).some(event => event.id === firstEvent.id));
    assert.ok(repository.listManualProgress(target.id).some(event => event.id === secondEvent.id));
    assert.equal(repository.getThread(target.id).status, 'Offer');
    assert.equal(repository.getThread(target.id).latestMessageId, source.messageId);
    assert.equal(repository.getThread(target.id).latestReceivedAt, '2026-09-03T00:00:00.000Z');
    assert.deepEqual(database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all(), archivedBefore);
    repository.deleteOrphanEmailThreads();
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
  });
});

test('merge chooses the latest actual mail instead of target identity or a future appointment', async () => {
  await fixture(async ({ repository, request }) => {
    const target = mail(repository, 'head-target', { receivedAt: '2026-09-01T00:00:00.000Z' });
    const source = mail(repository, 'head-source', { position: '岗位乙', status: '面试', receivedAt: '2026-09-03T00:00:00.000Z' });
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.company, COMPANY);
    assert.equal(result.body.position, '岗位甲');
    assert.equal(result.body.status, '面试');
    assert.equal(result.body.latestMessageId, source.messageId);
    assert.equal(result.body.latestReceivedAt, '2026-09-03T00:00:00.000Z');
  });
});

test('merge uses a stable message-id tie break when the newest email timestamps match', async () => {
  await fixture(async ({ repository, request }) => {
    const target = mail(repository, 'tie-target');
    const source = mail(repository, 'tie-source', { position: '岗位乙', status: '面试' });
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.latestMessageId, source.messageId);
    assert.equal(result.body.status, '面试');
    assert.equal(repository.listThreadMessages(target.id)[0].id, source.messageId);
  });
});

test('explicit merge resolves an edit collision without changing the archived company or position', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'collision-target', { company: '目标公司', position: '产品经理' });
    const source = mail(repository, 'collision-source', { company: '旧识别公司', position: '旧识别岗位' });
    const patch = { company: '目标公司', position: '产品经理', status: '面试', eventStart: '2026-10-09T01:00:00.000Z' };
    const before = snapshot(database);
    const conflict = await request(`/api/progress/${source.id}`, patch, 'PUT');
    assert.equal(conflict.status, 409);
    assert.deepEqual(snapshot(database), before);
    const merged = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id], progress: patch });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.company, '目标公司');
    assert.equal(merged.body.position, '产品经理');
    const archived = repository.findByKey(source.message.messageKey);
    assert.equal(archived.company, '旧识别公司');
    assert.equal(archived.position, '旧识别岗位');
    assert.deepEqual(messageIds(repository, target.id), [target.messageId, source.messageId].sort((a, b) => a - b));
  });
});

test('replay of a merged email cannot restore its former company, position or soft source', async () => {
  await fixture(async ({ repository, request }) => {
    const target = mail(repository, 'identity-target', { company: '人工确认公司', position: '人工确认岗位' });
    const source = mail(repository, 'identity-source', { company: '旧模型公司', position: '旧模型岗位' });
    const merged = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id] });
    assert.equal(merged.status, 200);
    const service = createSyncService({ repository, analysisVersion: 'restructure-company-replay',
      classifier: async () => ({ ...source.analysis, threadRef: 'new' }), triage: () => ({ decision: 'analyze' }) });
    await service.syncMessages({ accountId: ACCOUNT, from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z',
      source: 'fixture', messages: [source.message] });
    assert.deepEqual(ids(repository.listThreads()), [target.id]);
    assert.equal(repository.getThread(target.id).company, '人工确认公司');
    assert.equal(repository.getThread(target.id).position, '人工确认岗位');
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
    assert.deepEqual(messageIds(repository, source.id), []);
    assert.deepEqual(ids(repository.listManualThreadRoutesForMessage(source.messageId)), [target.id]);
    assert.equal(repository.findByKey(source.message.messageKey).company, '旧模型公司');
    assert.equal(repository.findByKey(source.message.messageKey).position, '旧模型岗位');
  });
});

test('a merge while classification is pending cannot route fresh mail into the hidden source', async () => {
  await fixture(async ({ repository }) => {
    const target = mail(repository, 'pending-merge-target', { position: '岗位甲' });
    const source = mail(repository, 'pending-merge-source', { position: '', receivedAt: '2026-09-02T00:00:00.000Z' });
    let markStarted;
    let finishClassification;
    const started = new Promise(resolve => { markStarted = resolve; });
    const released = new Promise(resolve => { finishClassification = resolve; });
    const fresh = {
      ...source.message,
      messageKey: undefined,
      messageId: '<pending-merge-fresh@restructure.example.test>',
      uid: 'pending-merge-fresh',
      receivedAt: '2026-09-03T00:00:00.000Z',
      subject: `${COMPANY} 新邮件进度通知`,
      text: '等待模型分析时收到的新进度通知',
    };
    const service = createSyncService({ repository, analysisVersion: 'pending-merge-v1',
      triage: () => ({ decision: 'analyze' }),
      classifier: async () => {
        markStarted();
        await released;
        return { ...source.analysis, position: '', status: '面试', threadRef: source.id };
      },
    });
    const syncing = service.syncMessages({ accountId: ACCOUNT, source: 'fixture',
      from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z', messages: [fresh] });
    await started;
    const preview = repository.previewThreadMerge({ targetId: target.id, sourceIds: [source.id] });
    repository.mergeThreads({ targetId: target.id, sourceIds: [source.id], expectedUpdatedAt: preview.expectedUpdatedAt });
    finishClassification();
    const summary = await syncing;
    assert.equal(summary.inserted, 1);
    const saved = repository.findByKey(`${ACCOUNT}|message-id|${fresh.messageId}`);
    assert.ok(saved);
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
    assert.deepEqual(messageIds(repository, source.id), []);
    assert.ok(messageIds(repository, target.id).includes(saved.id));
    assert.deepEqual(ids(repository.listThreads()), [target.id]);
    assert.equal(repository.getThread(target.id).position, '岗位甲');
  });
});

test('splitting preserves selected progress and rejects an attempt to change its stage during ownership transfer', async () => {
  for (const status of ['已结束', '面试']) {
    await fixture(async ({ database, repository }) => {
      const source = mail(repository, `split-notes-${status}`);
      const link = 'https://assessment.example.test/split-status';
      const eventEnd = '2030-10-09T02:00:00.000Z';
      const assessmentNotes = buildProgressNotes({ status: '测评中', actionLink: link, eventEnd });
      repository.applyManualProgress({ threadId: source.id, company: COMPANY, position: '岗位甲', status: '测评中',
        receivedAt: '2026-09-05T00:00:00.000Z', eventStart: '2030-10-09T01:00:00.000Z', eventEnd, notes: assessmentNotes });
      const selected = repository.listManualProgress(source.id)[0];
      const archivedBefore = database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();
      const before = snapshot(database);
      assert.throws(() => repository.splitThread({ threadId: source.id, manualEventIds: [selected.id],
        company: COMPANY, position: '岗位乙', status, expectedUpdatedAt: repository.getThread(source.id).updatedAt }), /拆分只调整进展归属/);
      assert.deepEqual(snapshot(database), before);
      const child = repository.splitThread({ threadId: source.id, manualEventIds: [selected.id], company: COMPANY, position: '岗位乙' });
      assert.equal(child.status, selected.status);
      assert.equal(child.notes, assessmentNotes);
      assert.deepEqual(database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all(), archivedBefore);
      const moved = repository.listManualProgress(child.id).find(row => row.id === selected.id);
      assert.deepEqual({ ...moved }, { ...selected, threadId: child.id });
      assert.equal(repository.getThread(source.id).company, COMPANY);
      assert.equal(repository.getThread(source.id).position, '岗位甲');
      assert.deepEqual(messageIds(repository, source.id), [source.messageId]);
    });
  }
});

test('direct message writes cannot update or attach mail to a merged source', async () => {
  await fixture(async ({ database, repository }) => {
    const target = mail(repository, 'hidden-write-target');
    const source = mail(repository, 'hidden-write-source', { position: '岗位乙' });
    const other = mail(repository, 'hidden-write-other', { company: '独立公司', position: '岗位丙' });
    repository.mergeThreads({ targetId: target.id, sourceIds: [source.id] });
    const before = snapshot(database);
    const patch = { threadId: source.id, accountId: ACCOUNT, company: '不应写入的公司', position: '不应写入的岗位',
      status: '面试', confidence: 1, needsReview: false, receivedAt: '2035-01-01T00:00:00.000Z',
      messageId: other.messageId, notes: 'https://interview.example.test/hidden-write' };
    assert.throws(() => repository.upsertThreadFromMessage(patch), { code: 'PROGRESS_STALE' });
    assert.equal(repository.linkMessageToThread(source.id, other.messageId), false);
    assert.equal(repository.touchThreadStatus(source.id, patch), false);
    assert.deepEqual(snapshot(database), before);
    assert.deepEqual(messageIds(repository, source.id), []);
    assert.deepEqual(messageIds(repository, target.id), [target.messageId, source.messageId].sort((a, b) => a - b));
    assert.deepEqual(messageIds(repository, other.id), [other.messageId]);
  });
});

test('structure exposes selectable mail and manual event ids, and same-key splitting remains separate', async () => {
  await fixture(async ({ repository, request }) => {
    const first = mail(repository, 'split-first');
    const second = mail(repository, 'split-second', { threadId: first.id, receivedAt: '2026-09-03T00:00:00.000Z', status: '面试' });
    const event = manual(repository, first.id);
    const structure = await request(`/api/progress/${first.id}/structure`);
    assert.equal(structure.status, 200);
    assert.equal(structure.body.thread.id, first.id);
    assert.deepEqual(ids(structure.body.messages), [first.messageId, second.messageId].sort((a, b) => a - b));
    assert.ok(structure.body.manualEvents.some(row => row.id === event.id));
    const split = await request(`/api/progress/${first.id}/split`, {
      messageIds: [second.messageId], manualEventIds: [event.id], company: COMPANY, position: '岗位甲', status: '面试',
    });
    assert.equal(split.status, 200);
    assert.notEqual(split.body.id, first.id);
    assert.deepEqual(ids(repository.listThreads()), [first.id, split.body.id].sort((a, b) => a - b));
    assert.deepEqual(messageIds(repository, first.id), [first.messageId]);
    assert.deepEqual(messageIds(repository, split.body.id), [second.messageId]);
    assert.ok(repository.listManualProgress(split.body.id).some(row => row.id === event.id));
    assert.ok(!repository.listManualProgress(first.id).some(row => row.id === event.id));
  });
});

test('invalid merge members and stale versions fail atomically', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'guard-target');
    const source = mail(repository, 'guard-source', { position: '岗位乙' });
    const foreign = mail(repository, 'guard-foreign', { accountId: 'another@example.test', position: '岗位丙' });
    for (const sourceIds of [[source.id, foreign.id], [source.id, 999999], [source.id, target.id]]) {
      const before = snapshot(database);
      const result = await request('/api/progress/merge', { targetId: target.id, sourceIds });
      assert.ok(result.status >= 400, JSON.stringify(result));
      assert.deepEqual(snapshot(database), before);
    }
    const before = snapshot(database);
    const stale = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id],
      expectedUpdatedAt: { [target.id]: '1900-01-01T00:00:00.000Z', [source.id]: repository.getThread(source.id).updatedAt } });
    assert.equal(stale.status, 409);
    assert.deepEqual(snapshot(database), before);
  });
});

test('split rejects foreign selections, emptying the source and stale versions atomically', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'guard-split-source');
    const sibling = mail(repository, 'guard-split-sibling', { threadId: source.id, receivedAt: '2026-09-02T00:00:00.000Z' });
    const foreign = mail(repository, 'guard-split-foreign', { position: '岗位乙' });
    const otherMailbox = mail(repository, 'guard-split-other-mailbox', { accountId: 'another@example.test', position: '岗位丙' });
    const otherMailboxSecond = mail(repository, 'guard-split-other-mailbox-second', {
      accountId: 'another@example.test', position: '岗位丙', threadId: otherMailbox.id, receivedAt: '2026-09-03T00:00:00.000Z',
    });
    const foreignEvent = manual(repository, foreign.id, { position: '岗位乙' });
    const patch = { company: COMPANY, position: '岗位丙', status: '面试' };
    for (const selection of [
      { messageIds: [sibling.messageId, foreign.messageId], manualEventIds: [] },
      { messageIds: [sibling.messageId], manualEventIds: [foreignEvent.id] },
      { messageIds: [source.messageId, sibling.messageId], manualEventIds: [] },
    ]) {
      const before = snapshot(database);
      const result = await request(`/api/progress/${source.id}/split`, { ...patch, ...selection });
      assert.ok(result.status >= 400, JSON.stringify(result));
      assert.deepEqual(snapshot(database), before);
    }
    const before = snapshot(database);
    const stale = await request(`/api/progress/${source.id}/split`, { ...patch, messageIds: [sibling.messageId],
      expectedUpdatedAt: '1900-01-01T00:00:00.000Z' });
    assert.equal(stale.status, 409);
    assert.deepEqual(snapshot(database), before);
    const foreignBefore = snapshot(database);
    const forbidden = await request(`/api/progress/${otherMailbox.id}/split`, { ...patch, messageIds: [otherMailboxSecond.messageId] });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(snapshot(database), foreignBefore);
  });
});

test('splitting a shared mail preserves sibling owners through job and non-job replay', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'fanout-source');
    const sibling = mail(repository, 'fanout-sibling', { position: '岗位乙' });
    const shared = mail(repository, 'fanout-shared', { threadId: source.id, status: '测评中', receivedAt: '2026-09-03T00:00:00.000Z' });
    repository.linkMessageToThread(sibling.id, shared.messageId);
    const split = await request(`/api/progress/${source.id}/split`, {
      messageIds: [shared.messageId], company: COMPANY, position: '岗位丙', status: '测评中',
    });
    assert.equal(split.status, 200);
    const owners = () => database.db.prepare(`SELECT thread_id AS id FROM application_thread_messages
      WHERE message_id=? ORDER BY thread_id`).all(shared.messageId).map(row => Number(row.id));
    const expectedOwners = [sibling.id, split.body.id].sort((a, b) => a - b);
    assert.deepEqual(owners(), expectedOwners);
    for (const [version, analysis] of [
      ['restructure-replay-job', { ...shared.analysis, position: '', threadRef: 'new', appliesToAll: true }],
      ['restructure-replay-non-job', { ...shared.analysis, isJobRelated: false, status: '已结束' }],
    ]) {
      const service = createSyncService({ repository, analysisVersion: version,
        classifier: async () => analysis, triage: () => ({ decision: 'analyze' }) });
      await service.syncMessages({ accountId: ACCOUNT, from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z',
        source: 'fixture', messages: [shared.message] });
      assert.deepEqual(owners(), expectedOwners);
      assert.ok(!messageIds(repository, source.id).includes(shared.messageId));
      assert.equal(repository.listThreads().length, 3);
    }
  });
});

test('merge chains flatten soft sources and their pinned mail routes to the final target', async () => {
  await fixture(async ({ repository, request }) => {
    const first = mail(repository, 'chain-first');
    const second = mail(repository, 'chain-second', { position: '岗位乙' });
    const target = mail(repository, 'chain-target', { position: '岗位丙' });
    assert.equal((await request('/api/progress/merge', { targetId: second.id, sourceIds: [first.id] })).status, 200);
    assert.equal((await request('/api/progress/merge', { targetId: target.id, sourceIds: [second.id] })).status, 200);
    assert.equal(repository.getThread(first.id).mergedIntoThreadId, target.id);
    assert.equal(repository.getThread(second.id).mergedIntoThreadId, target.id);
    assert.deepEqual(messageIds(repository, first.id), []);
    assert.deepEqual(messageIds(repository, second.id), []);
    assert.deepEqual(messageIds(repository, target.id), [first.messageId, second.messageId, target.messageId].sort((a, b) => a - b));
    for (const item of [first, second]) {
      assert.deepEqual(ids(repository.listManualThreadRoutesForMessage(item.messageId)), [target.id]);
    }
  });
});

test('reopening an isolated file database neither resurrects source links nor loses a soft source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-restructure-'));
  const path = join(directory, 'fixture.sqlite');
  let database;
  try {
    database = createDatabase(path);
    let repository = createMessageRepository(database.db);
    const source = mail(repository, 'reopen-source');
    const target = mail(repository, 'reopen-target', { position: '岗位乙' });
    const merged = repository.mergeThreads({ targetId: target.id, sourceIds: [source.id] });
    assert.equal(merged.id, target.id);
    repository.deleteOrphanEmailThreads();
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
    database.close();
    database = createDatabase(path);
    repository = createMessageRepository(database.db);
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
    assert.deepEqual(messageIds(repository, source.id), []);
    assert.deepEqual(messageIds(repository, target.id), [source.messageId, target.messageId].sort((a, b) => a - b));
    assert.deepEqual(ids(repository.listManualThreadRoutesForMessage(source.messageId)), [target.id]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count, 2);
  } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an ignored older mail does not poison routing for a genuinely later positionless update', async () => {
  await fixture(async ({ repository }) => {
    const current = mail(repository, 'time-current', { position: '后端', status: 'Offer', receivedAt: '2026-10-01T00:00:00.000Z' });
    manual(repository, current.id, { position: '后端', status: 'Offer', recordedAt: '2026-10-08T00:00:00.000Z' });
    const analysis = subject => ({ isJobRelated: true, company: COMPANY, position: subject === '旧通知' ? '后端' : '',
      status: subject === '旧通知' ? '已结束' : '面试', confidence: .9, needsReview: false,
      evidence: '进度通知', nextAction: '等待', threadRef: 'new' });
    const service = createSyncService({ repository, analysisVersion: 'restructure-time-v1',
      classifier: async ({ subject }) => analysis(subject), triage: () => ({ decision: 'analyze' }) });
    await service.syncMessages({ accountId: ACCOUNT, from: '2026-09-01T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z', source: 'fixture',
      messages: [
        { messageId: '<restructure-old@example.test>', provider: 'qq', folder: 'INBOX', uid: 'old', receivedAt: '2026-09-01T00:00:00.000Z',
          subject: '旧通知', text: '流程已结束', sender: 'hr@restructure.example.test' },
        { messageId: '<restructure-new@example.test>', provider: 'qq', folder: 'INBOX', uid: 'new', receivedAt: '2026-10-09T00:00:00.000Z',
          subject: '新通知', text: '请确认后续安排', sender: 'hr@restructure.example.test' },
      ] });
    assert.deepEqual(ids(repository.listThreads()), [current.id]);
    assert.equal(repository.getThread(current.id).position, '后端');
    assert.equal(repository.getThread(current.id).status, '面试');
    assert.equal(repository.getThread(current.id).latestReceivedAt, '2026-10-09T00:00:00.000Z');
  });
});

test('a legacy manual-account target can absorb an email application from the current mailbox', async () => {
  await fixture(async ({ repository, request }) => {
    const target = repository.addManualThread({ accountId: 'manual', company: COMPANY, position: '手动确认岗位',
      status: '面试', receivedAt: '2026-09-05T00:00:00.000Z', eventStart: '2030-10-09T01:00:00.000Z' });
    const source = mail(repository, 'legacy-manual-source', { position: '邮件识别岗位' });
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, target.id);
    assert.deepEqual(messageIds(repository, target.id), [source.messageId]);
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target.id);
  });
});

test('a partial merge identity patch preserves the chosen progress notes and appointment', async () => {
  await fixture(async ({ repository, request }) => {
    const target = mail(repository, 'partial-target');
    const source = mail(repository, 'partial-source', { position: '岗位乙' });
    manual(repository, target.id);
    const before = repository.getThread(target.id);
    assert.ok(before.notes.includes('https://meeting.example.test/restructure'));
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id],
      progress: { company: '人工纠正公司名称' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.company, '人工纠正公司名称');
    assert.equal(result.body.status, before.status);
    assert.equal(result.body.notes, before.notes);
    assert.equal(result.body.eventStart, before.eventStart);
  });
});

test('merge and split reject an end date without a start date and leave ownership unchanged', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'date-target');
    const source = mail(repository, 'date-source', { position: '岗位乙' });
    const sibling = mail(repository, 'date-source-sibling', { threadId: source.id, position: '岗位乙', receivedAt: '2026-09-02T00:00:00.000Z' });
    const end = '2030-10-09T02:00:00.000Z';
    const before = snapshot(database);
    const merged = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id],
      progress: { eventStart: null, eventEnd: end } });
    assert.equal(merged.status, 400);
    assert.deepEqual(snapshot(database), before);
    const split = await request(`/api/progress/${source.id}/split`, { messageIds: [sibling.messageId],
      company: COMPANY, position: '拆出岗位', status: '面试', eventStart: null, eventEnd: end });
    assert.equal(split.status, 400);
    assert.deepEqual(snapshot(database), before);
  });
});

test('a preview becomes stale when an older fanout mail adds an owner without changing summary status', async () => {
  await fixture(async ({ database, repository, request }) => {
    const target = mail(repository, 'version-target');
    const source = mail(repository, 'version-source', { position: '岗位乙' });
    const old = mail(repository, 'version-old-fanout', { position: '岗位丙', receivedAt: '2026-08-01T00:00:00.000Z' });
    const preview = await request(`/api/progress/merge-preview?targetId=${target.id}&sourceIds=${source.id}`);
    assert.equal(preview.status, 200);
    const previousStatus = repository.getThread(target.id).status;
    assert.equal(repository.touchThreadStatus(target.id, { status: '测评中', receivedAt: old.message.receivedAt,
      messageId: old.messageId }), false);
    repository.linkMessageToThread(target.id, old.messageId);
    assert.equal(repository.getThread(target.id).status, previousStatus);
    const beforeMerge = snapshot(database);
    const result = await request('/api/progress/merge', { targetId: target.id, sourceIds: [source.id],
      expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(result.status, 409);
    assert.deepEqual(snapshot(database), beforeMerge);
  });
});

test('a fresh unpinned same-key mail does not choose an explicitly separated child implicitly', async () => {
  await fixture(async ({ repository, request }) => {
    const source = mail(repository, 'separate-source');
    const moved = mail(repository, 'separate-moved', { threadId: source.id, receivedAt: '2026-09-02T00:00:00.000Z' });
    const split = await request(`/api/progress/${source.id}/split`, { messageIds: [moved.messageId],
      company: COMPANY, position: '岗位甲', status: '已投递' });
    assert.equal(split.status, 200);
    const childBefore = repository.getThread(split.body.id);
    assert.equal(childBefore.manualSeparate, true);
    const fresh = { messageId: '<separate-fresh@restructure.example.test>', provider: 'qq', folder: 'INBOX', uid: 'separate-fresh',
      receivedAt: '2031-01-01T00:00:00.000Z', subject: '岗位新进展', text: '请确认后续安排', sender: 'hr@restructure.example.test' };
    const service = createSyncService({ repository, analysisVersion: 'restructure-fresh-v1',
      classifier: async () => ({ ...source.analysis, status: '面试', threadRef: 'new' }), triage: () => ({ decision: 'analyze' }) });
    await service.syncMessages({ accountId: ACCOUNT, from: '2031-01-01T00:00:00.000Z', to: '2031-01-02T00:00:00.000Z',
      source: 'fixture', messages: [fresh] });
    assert.deepEqual(messageIds(repository, split.body.id), [moved.messageId]);
    assert.equal(repository.getThread(split.body.id).status, childBefore.status);
    assert.equal(repository.getThread(split.body.id).latestMessageId, childBefore.latestMessageId);
  });
});

test('a renamed split child exposes the moved email original company and position as name history', async () => {
  await fixture(async ({ repository, request }) => {
    const source = mail(repository, 'original-name-source', { company: '原邮件公司', position: '原邮件岗位' });
    const moved = mail(repository, 'original-name-moved', { threadId: source.id, company: '原邮件公司',
      position: '原邮件岗位', receivedAt: '2026-09-02T00:00:00.000Z' });
    const split = await request(`/api/progress/${source.id}/split`, { messageIds: [moved.messageId],
      company: '人工更正公司', position: '人工更正岗位' });
    assert.equal(split.status, 200);
    const child = repository.listThreads().find(row => row.id === split.body.id);
    assert.ok(child.originalApplications.some(row => row.company === '原邮件公司' && row.position === '原邮件岗位'));
  });
});

test('moving the latest manual event recomputes the source from remaining mail without inventing a history item', async () => {
  await fixture(async ({ repository, request }) => {
    const source = mail(repository, 'remaining-source');
    const latestMail = mail(repository, 'remaining-latest-mail', { threadId: source.id, status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z' });
    const movedEvent = manual(repository, source.id, { recordedAt: '2026-09-05T00:00:00.000Z' });
    const split = await request(`/api/progress/${source.id}/split`, { manualEventIds: [movedEvent.id],
      company: COMPANY, position: '人工事件独立岗位', status: '面试' });
    assert.equal(split.status, 200);
    const kept = repository.getThread(source.id);
    assert.equal(kept.status, '测评中');
    assert.equal(kept.latestMessageId, latestMail.messageId);
    assert.equal(kept.latestReceivedAt, latestMail.message.receivedAt);
    assert.deepEqual(repository.listManualProgress(source.id), []);
    assert.equal(repository.getThreadStructure(source.id).history[0].status, '测评中');
    assert.ok(repository.listManualProgress(split.body.id).some(row => row.id === movedEvent.id));
  });
});

test('deleting one pinned shared-mail owner preserves the remaining authoritative owners during replay', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'delete-owner-source');
    const sibling = mail(repository, 'delete-owner-sibling', { position: '岗位乙' });
    const shared = mail(repository, 'delete-owner-shared', { threadId: source.id, status: '测评中',
      receivedAt: '2026-09-03T00:00:00.000Z' });
    repository.linkMessageToThread(sibling.id, shared.messageId);
    const split = await request(`/api/progress/${source.id}/split`, { messageIds: [shared.messageId],
      company: COMPANY, position: '岗位丙', status: '测评中' });
    assert.equal(split.status, 200);
    const deleted = await request('/api/progress/delete', { ids: [split.body.id] });
    assert.equal(deleted.status, 200);
    assert.deepEqual(ids(repository.listManualThreadRoutesForMessage(shared.messageId)), [sibling.id]);
    const service = createSyncService({ repository, analysisVersion: 'restructure-delete-replay',
      classifier: async () => ({ ...shared.analysis, position: '', appliesToAll: true, threadRef: 'new' }),
      triage: () => ({ decision: 'analyze' }) });
    await service.syncMessages({ accountId: ACCOUNT, from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z',
      source: 'fixture', messages: [shared.message] });
    assert.deepEqual(database.db.prepare('SELECT thread_id AS id FROM application_thread_messages WHERE message_id=? ORDER BY thread_id')
      .all(shared.messageId).map(row => Number(row.id)), [sibling.id]);
    assert.equal(repository.getThread(split.body.id), null);
    assert.ok(!messageIds(repository, source.id).includes(shared.messageId));
  });
});
