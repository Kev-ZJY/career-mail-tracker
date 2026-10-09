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

async function fixture(run) {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const settingsService = createSettingsService({ repository, credentialStore: createCredentialStore() });
  settingsService.saveMailbox({ provider: 'qq', email: 'fixture@example.test' });
  const config = { port: 0 };
  const server = http.createServer(createApi({ config, repository, settingsService }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: body ? method : 'GET',
      headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ database, repository, request }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); database.close(); }
}

function emailThread(repository, company = '示例飞机公司', position = '') {
  const receivedAt = '2026-09-27T07:23:45.000Z';
  const mail = repository.saveAnalysis({ accountId: 'fixture@example.test', provider: 'qq', folder: 'INBOX',
    messageKey: `fixture|${company}|${position}`, receivedAt, sender: 'hr@example.test', subject: '测评通知',
    text: '原始邮件正文', contentHash: company + position, analysisVersion: 'fixture-v1', analyzedAt: receivedAt,
    analysis: { isJobRelated: true, company, position, status: '测评中', confidence: .9,
      evidence: '测评通知', nextAction: '完成测评', needsReview: false } });
  const id = Number(repository.upsertThreadFromMessage({ accountId: 'fixture@example.test', company, position,
    status: '测评中', confidence: .9, receivedAt, messageId: mail.id }));
  repository.linkMessageToThread(id, mail.id);
  return id;
}

function interview(company = '示例飞机公司') {
  return { company, position: '数字仿真工程师', status: '面试', eventStart: '2030-10-09T01:15:00.000Z',
    eventEnd: '2030-10-09T02:00:00.000Z', notes: 'https://meeting.example.test/room' };
}

test('future interview appears in the current recording window without changing its appointment date', async () => {
  await fixture(async ({ request }) => {
    const before = new Date(Date.now() - 1000).toISOString();
    const result = await request('/api/progress/manual', interview());
    assert.equal(result.status, 200);
    assert.equal(result.body.eventStart, interview().eventStart);
    assert.ok(Date.parse(result.body.latestReceivedAt) <= Date.now());
    const dashboard = await request(`/api/dashboard?from=${before}&to=${new Date(Date.now() + 1000).toISOString()}`);
    assert.equal(dashboard.body.total, 1);
    assert.equal(dashboard.body.recent[0].status, '面试');
  });
});

test('explicit existing application receives manual progress, sorts first and keeps its original mail date', async () => {
  await fixture(async ({ repository, request }) => {
    const id = emailThread(repository);
    emailThread(repository, '另一个公司', '工程师');
    const result = await request('/api/progress/manual', { ...interview(), threadId: id });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, id);
    assert.equal(result.body.status, '面试');
    assert.equal(result.body.latestReceivedAt, '2026-09-27T07:23:45.000Z');
    assert.equal(result.body.manualPositionOverride, true);
    assert.equal(repository.listThreads().length, 2);
    const dashboard = await request('/api/dashboard');
    assert.equal(dashboard.body.recent[0].id, id);
    assert.equal(repository.listManualProgress(id).length, 1);
    assert.equal(repository.listManualProgress(id)[0].eventStart, interview().eventStart);
  });
});

test('editing email progress corrects its history without inventing a manual event or changing the mail date', async () => {
  await fixture(async ({ database, repository, request }) => {
    const id = emailThread(repository);
    const mails = repository.listThreadMessages(id);
    const result = await request(`/api/progress/${id}`, interview(), 'PUT');
    assert.equal(result.status, 200);
    assert.equal(result.body.manualUpdatedAt, null);
    assert.equal(result.body.latestReceivedAt, '2026-09-27T07:23:45.000Z');
    assert.equal(repository.listManualProgress(id).length, 0);
    const history = repository.getThreadStructure(id).history;
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, 'email');
    assert.equal(history[0].status, '面试');
    assert.equal(history[0].recordedAt, result.body.latestReceivedAt);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count, 1);
    assert.deepEqual(repository.listThreadMessages(id), mails);
  });
});

test('a status-only manual correction survives actual model-version replay even if the old mail is reclassified', async () => {
  await fixture(async ({ repository, request }) => {
    const position = '数字仿真工程师';
    const message = { messageId: '<manual-route@example.test>', provider: 'qq', folder: 'INBOX', uidValidity: '77', uid: '10',
      subject: '示例飞机公司岗位申请确认', text: '已收到您的岗位申请', sender: 'hr@example.test',
      receivedAt: '2026-09-27T07:23:45.000Z' };
    const analysis = { isJobRelated: true, company: '示例飞机公司', position, status: '测评中', confidence: .9,
      evidence: '申请确认', nextAction: '等待通知', needsReview: false, threadRef: 'new' };
    const run = async (version, result) => createSyncService({ repository, analysisVersion: version, classifier: async () => result,
      triage: () => ({ decision: 'analyze' }) }).syncMessages({ accountId: 'fixture@example.test', from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z', messages: [message] });
    await run('manual-route-v1', analysis);
    const id = repository.listThreads()[0].id;
    const updated = await request('/api/progress/manual', { ...interview(), threadId: id });
    assert.equal(updated.body.manualPositionOverride, false);
    await run('manual-route-v2', { ...analysis, isJobRelated: false, status: '已结束' });
    assert.equal(repository.listThreads().length, 1);
    assert.equal(repository.getThread(id).status, '面试');
    assert.equal(repository.listThreadMessages(id).length, 1);
  });
});

test('conflicting target updates roll back status, routing and manual event insertion together', async () => {
  await fixture(async ({ repository, request }) => {
    const first = emailThread(repository, '示例飞机公司', '岗位甲');
    emailThread(repository, '示例飞机公司', '岗位乙');
    const before = repository.getThread(first);
    const result = await request('/api/progress/manual', { ...interview(), position: '岗位乙', threadId: first });
    assert.notEqual(result.status, 200);
    assert.deepEqual(repository.getThread(first), before);
    assert.equal(repository.listManualProgress(first).length, 0);
  });
});

test('old/replayed and fanout mail cannot undo manual status, while a genuinely later mail may advance it', async () => {
  await fixture(async ({ repository, request }) => {
    const id = emailThread(repository);
    const updated = (await request('/api/progress/manual', { ...interview(), threadId: id })).body;
    const old = { threadId: id, accountId: 'fixture@example.test', company: updated.company, position: '',
      status: '测评中', confidence: .8, receivedAt: '2026-09-28T00:00:00.000Z' };
    repository.upsertThreadFromMessage(old);
    assert.equal(repository.getThread(id).status, '面试');
    assert.equal(repository.touchThreadStatus(id, old), false);
    const later = new Date(Date.parse(updated.manualUpdatedAt) + 1000).toISOString();
    repository.upsertThreadFromMessage({ ...old, receivedAt: later, status: 'Offer' });
    assert.equal(repository.getThread(id).status, 'Offer');
    assert.equal(repository.getThread(id).position, '数字仿真工程师');
  });
});

test('manual routing is explicit and rejects missing targets, another mailbox and a different company', async () => {
  await fixture(async ({ repository, request }) => {
    const id = emailThread(repository);
    assert.equal((await request('/api/progress/manual', { ...interview(), threadId: 999999 })).status, 404);
    assert.notEqual((await request('/api/progress/manual', { ...interview('无关公司'), threadId: id })).status, 200);
    const foreign = Number(repository.upsertThreadFromMessage({ accountId: 'other@example.test', company: '示例飞机公司',
      position: '', status: '测评中', confidence: .9, receivedAt: '2026-09-27T00:00:00.000Z' }));
    assert.notEqual((await request('/api/progress/manual', { ...interview(), threadId: foreign })).status, 200);
    assert.equal(repository.getThread(id).status, '测评中');
    assert.equal(repository.getThread(foreign).status, '测评中');
  });
});

test('moving an independent manual record into a chosen application preserves history and its original record', async () => {
  await fixture(async ({ repository, request }) => {
    const target = emailThread(repository);
    const source = (await request('/api/progress/manual', interview('示例飞机北京研究中心'))).body;
    const result = await request('/api/progress/manual', { ...interview(), threadId: target, mergeFromId: source.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, target);
    assert.equal(repository.listThreads().length, 1);
    assert.equal(repository.getThread(source.id).mergedIntoThreadId, target);
    assert.ok(repository.listManualProgress(target).some(event => event.company === '示例飞机北京研究中心'));
    assert.equal(repository.getThread(target).status, '面试');
  });
});

test('legacy manual future event uses its actual save time on reopen and migration is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-manual-'));
  const path = join(directory, 'fixture.sqlite');
  let database;
  try {
    database = createDatabase(path);
    const repository = createMessageRepository(database.db);
    const row = repository.addManualThread({ ...interview(), receivedAt: interview().eventStart, evidence: '', nextAction: '' });
    database.db.prepare('UPDATE application_threads SET manual_updated_at=NULL,updated_at=? WHERE id=?').run('2026-10-08T08:25:15.832Z', row.id);
    database.db.prepare('DELETE FROM manual_progress_events WHERE thread_id=?').run(row.id);
    database.close();
    database = createDatabase(path);
    const migrated = createMessageRepository(database.db).getThread(row.id);
    assert.equal(migrated.latestReceivedAt, '2026-10-08T08:25:15.832Z');
    assert.equal(migrated.eventStart, interview().eventStart);
    assert.equal(migrated.eventEnd, interview().eventEnd);
    assert.equal(createMessageRepository(database.db).listManualProgress(row.id).length, 1);
    database.close();
    database = createDatabase(path);
    assert.equal(createMessageRepository(database.db).listManualProgress(row.id).length, 1);
  } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
});
