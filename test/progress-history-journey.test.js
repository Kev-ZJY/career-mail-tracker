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

const ACCOUNT = 'journey@example.test';
const COMPANY = '示例旅程测试公司';

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
      method: body ? method : 'GET', headers: { 'content-type': 'application/json' },
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
  accountId = ACCOUNT, company = COMPANY, position = '示例业务培训生-航线', status = '已投递',
  receivedAt = '2026-09-01T00:00:00.000Z', eventStart = receivedAt, eventEnd = null,
  notes = null, threadId,
} = {}) {
  const message = {
    messageKey: `journey|${accountId}|${key}`, messageId: `<${key}@journey.example.test>`,
    provider: 'qq', folder: 'INBOX', uidValidity: 'journey-1', uid: key, receivedAt,
    sender: 'hr@journey.example.test', subject: `${company} ${key} 招聘通知`,
    text: `原始测试邮件：${key}`,
  };
  const analysis = { isJobRelated: true, company, position, status, confidence: .9,
    eventStart, eventEnd, notes, evidence: `原始证据：${key}`, nextAction: '等待通知', needsReview: false };
  const saved = repository.saveAnalysis({ ...message, accountId, contentHash: `journey-hash-${key}`,
    analysisVersion: 'journey-v1', bodyText: message.text, bodyHtml: `<p>${key}</p>`,
    analyzedAt: receivedAt, analysis });
  const id = Number(repository.upsertThreadFromMessage({ ...analysis, threadId, accountId,
    receivedAt, messageId: saved.id }));
  repository.linkMessageToThread(id, saved.id, receivedAt);
  return { id, messageId: saved.id, message, analysis };
}

const numericIds = rows => rows.map(row => Number(row.id)).sort((a, b) => a - b);
const ownedMailIds = (repository, id) => numericIds(repository.listThreadMessages(id));
const manualCount = database => Number(database.db.prepare('SELECT COUNT(*) AS n FROM manual_progress_events').get().n);
const archives = database => database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();

function state(database) {
  return Object.fromEntries(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name}) => [name, database.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}

test('merging two email applications moves all correspondence without inventing manual progress', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route1 = mail(repository, 'route-submitted');
    const route2 = mail(repository, 'route-assessment', { threadId: route1.id, status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z', eventEnd: '2026-09-06T10:00:00.000Z' });
    const product1 = mail(repository, 'product-submitted', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    const product2 = mail(repository, 'product-interview', { threadId: product1.id, position: '示例业务培训生-产品', status: '面试',
      receivedAt: '2026-09-08T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z' });
    const beforeArchives = archives(database);
    const merged = await request('/api/progress/merge', { targetId: route1.id, sourceIds: [product1.id] });
    assert.equal(merged.status, 200);
    assert.deepEqual(ownedMailIds(repository, route1.id), [route1, route2, product1, product2].map(row => row.messageId).sort((a,b) => a-b));
    assert.equal(manualCount(database), 0, 'organizing an application is not a new recruitment progress record');
    assert.equal(merged.body.status, '面试');
    assert.equal(merged.body.eventStart, product2.analysis.eventStart);
    assert.equal(merged.body.eventEnd, product2.analysis.eventEnd);
    assert.equal(merged.body.progressUpdatedAt, product2.message.receivedAt, 'merge time must not become the latest real progress time');
    assert.deepEqual(archives(database), beforeArchives);
  });
});

test('one split transfers several mails together and derives both summaries from retained correspondence', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route1 = mail(repository, 'split-route-submitted');
    const route2 = mail(repository, 'split-route-assessment', { threadId: route1.id, status: '测评中', receivedAt: '2026-09-04T00:00:00.000Z',
      eventStart: '2026-09-05T01:00:00.000Z', eventEnd: '2026-09-06T10:00:00.000Z' });
    const product1 = mail(repository, 'split-product-submitted', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    const product2 = mail(repository, 'split-product-interview', { threadId: product1.id, position: '示例业务培训生-产品', status: '面试',
      receivedAt: '2026-09-08T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z' });
    await request('/api/progress/merge', { targetId: route1.id, sourceIds: [product1.id] });
    const split = await request(`/api/progress/${route1.id}/split`, { messageIds: [product1.messageId, product2.messageId],
      company: COMPANY, position: '示例业务培训生-产品', expectedUpdatedAt: repository.getThread(route1.id).updatedAt });
    assert.equal(split.status, 200);
    assert.deepEqual(ownedMailIds(repository, route1.id), [route1.messageId, route2.messageId].sort((a,b) => a-b));
    assert.deepEqual(ownedMailIds(repository, split.body.id), [product1.messageId, product2.messageId].sort((a,b) => a-b));
    assert.equal(repository.getThread(route1.id).status, '测评中');
    assert.equal(repository.getThread(route1.id).eventStart, route2.analysis.eventStart);
    assert.equal(repository.getThread(route1.id).eventEnd, route2.analysis.eventEnd);
    assert.equal(repository.getThread(route1.id).progressUpdatedAt, route2.message.receivedAt);
    assert.equal(split.body.status, '面试');
    assert.equal(split.body.eventStart, product2.analysis.eventStart);
    assert.equal(split.body.eventEnd, product2.analysis.eventEnd);
    assert.equal(split.body.progressUpdatedAt, product2.message.receivedAt);
    assert.equal(split.body.source, 'email', 'moving email-derived progress does not make the application a manual record');
    assert.equal(manualCount(database), 0);
    const childEmails = await request(`/api/progress/${split.body.id}/emails`);
    assert.equal(childEmails.status, 200);
    assert.deepEqual(numericIds(childEmails.body.messages), [product1.messageId, product2.messageId].sort((a,b) => a-b));
    assert.ok(childEmails.body.messages.every(row => row.bodyText && row.bodyHtml), 'every moved email remains readable');
  });
});

test('all real progress cannot be split away leaving only a technical operation behind', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route = mail(repository, 'all-route');
    const product = mail(repository, 'all-product', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    await request('/api/progress/merge', { targetId: route.id, sourceIds: [product.id] });
    const before = state(database);
    const result = await request(`/api/progress/${route.id}/split`, { messageIds: [route.messageId, product.messageId],
      company: COMPANY, position: '全部移出岗位' });
    assert.equal(result.status, 400);
    assert.deepEqual(state(database), before);
  });
});

test('renaming a company or position does not invent a new progress item or advance its real date', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'rename-only', { status: '面试', receivedAt: '2026-09-03T00:00:00.000Z',
      eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z' });
    const before = repository.getThread(source.id);
    const result = await request(`/api/progress/${source.id}`, { company: '确认后的测试公司', position: '确认后的岗位',
      status: before.status, eventStart: before.eventStart, eventEnd: before.eventEnd, notes: before.notes }, 'PUT');
    assert.equal(result.status, 200);
    assert.equal(result.body.company, '确认后的测试公司');
    assert.equal(result.body.position, '确认后的岗位');
    assert.equal(result.body.status, before.status);
    assert.equal(result.body.progressUpdatedAt, before.progressUpdatedAt);
    assert.equal(manualCount(database), 0);
    assert.deepEqual(ownedMailIds(repository, source.id), [source.messageId]);
  });
});

test('a genuine manual record can move without an email while both applications retain real histories', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'manual-source', { status: '测评中', receivedAt: '2026-09-04T00:00:00.000Z',
      eventStart: '2026-09-05T01:00:00.000Z', eventEnd: '2026-09-06T10:00:00.000Z' });
    repository.applyManualProgress({ threadId: source.id, company: COMPANY, position: '示例业务培训生-航线', status: '面试',
      receivedAt: '2026-09-09T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z',
      notes: 'https://meeting.example.test/manual-only' });
    const genuine = repository.listManualProgress(source.id)[0];
    const split = await request(`/api/progress/${source.id}/split`, { manualEventIds: [genuine.id],
      company: COMPANY, position: '人工补录的独立岗位', expectedUpdatedAt: repository.getThread(source.id).updatedAt });
    assert.equal(split.status, 200);
    assert.equal(split.body.source, 'manual');
    assert.equal(split.body.status, '面试');
    assert.equal(split.body.progressUpdatedAt, genuine.recordedAt);
    assert.deepEqual(ownedMailIds(repository, split.body.id), []);
    assert.deepEqual(numericIds(repository.listManualProgress(split.body.id)), [genuine.id]);
    assert.deepEqual(repository.listManualProgress(source.id), []);
    assert.equal(manualCount(database), 1, 'only the user-created record is progress; organization contributes no snapshots');
    assert.equal(repository.getThread(source.id).source, 'email');
    assert.equal(repository.getThread(source.id).status, source.analysis.status);
    assert.equal(repository.getThread(source.id).progressUpdatedAt, source.message.receivedAt);
    const childEmail = await request(`/api/progress/${split.body.id}/emails`);
    assert.equal(childEmail.status, 404);
  });
});

test('merge keeps genuinely entered progress by stable event identity rather than duplicating a final summary', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route = mail(repository, 'manual-merge-route', { status: '测评中' });
    const product = mail(repository, 'manual-merge-product', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    for (const entry of [route, product]) {
      repository.applyManualProgress({ threadId: entry.id, company: COMPANY, position: entry.analysis.position,
        status: '面试', receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z' });
    }
    const eventIds = [...repository.listManualProgress(route.id), ...repository.listManualProgress(product.id)].map(row => row.id).sort((a,b)=>a-b);
    const merged = await request('/api/progress/merge', { targetId: route.id, sourceIds: [product.id] });
    assert.equal(merged.status, 200);
    assert.deepEqual(numericIds(repository.listManualProgress(route.id)), eventIds);
    assert.equal(manualCount(database), 2);
    assert.equal(merged.body.progressUpdatedAt, '2026-09-04T00:00:00.000Z');
  });
});

test('moving several mails retains every confirmed owner when one mail is also shared with another application', async () => {
  await fixture(async ({ repository, request }) => {
    const route = mail(repository, 'shared-route');
    const product1 = mail(repository, 'shared-product-first', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    const product2 = mail(repository, 'shared-product-second', { threadId: product1.id, position: '示例业务培训生-产品', status: '面试',
      receivedAt: '2026-09-08T00:00:00.000Z' });
    const sibling = mail(repository, 'shared-it', { position: 'IT产品类', receivedAt: '2026-09-03T00:00:00.000Z' });
    repository.linkMessageToThread(sibling.id, product2.messageId);
    await request('/api/progress/merge', { targetId: route.id, sourceIds: [product1.id] });
    const split = await request(`/api/progress/${route.id}/split`, { messageIds: [product1.messageId, product2.messageId],
      company: COMPANY, position: '示例业务培训生-产品' });
    assert.equal(split.status, 200);
    const childId = split.body.id;
    for (const [version, isJobRelated] of [['journey-replay-job', true], ['journey-replay-other', false]]) {
      const service = createSyncService({ repository, analysisVersion: version,
        triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...product2.analysis,
          company: '错误识别公司', position: '', isJobRelated, appliesToAll: true, threadRef: 'new' }) });
      await service.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T23:59:59.999Z', messages: [product2.message] });
      assert.deepEqual(ownedMailIds(repository, route.id), [route.messageId]);
      assert.deepEqual(ownedMailIds(repository, childId), [product1.messageId, product2.messageId].sort((a,b)=>a-b));
      assert.deepEqual(ownedMailIds(repository, sibling.id), [product2.messageId, sibling.messageId].sort((a,b)=>a-b));
      assert.deepEqual(numericIds(repository.listManualThreadRoutesForMessage(product2.messageId)), [childId, sibling.id].sort((a,b)=>a-b));
      assert.deepEqual(numericIds(repository.listThreads()), [route.id, childId, sibling.id].sort((a,b)=>a-b));
      assert.equal(repository.getThread(childId).company, COMPANY);
      assert.equal(repository.getThread(childId).position, '示例业务培训生-产品');
    }
  });
});

test('one chronological progress history contains emails and genuine no-mail records with explicit source kinds', async () => {
  await fixture(async ({ repository, request }) => {
    const first = mail(repository, 'unified-submitted');
    const latest = mail(repository, 'unified-assessment', { threadId: first.id, status: '测评中', receivedAt: '2026-09-04T00:00:00.000Z' });
    repository.applyManualProgress({ threadId: first.id, company: COMPANY, position: first.analysis.position,
      status: '面试', receivedAt: '2026-09-09T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z' });
    const manualId = repository.listManualProgress(first.id)[0].id;
    const structure = await request(`/api/progress/${first.id}/structure`);
    assert.equal(structure.status, 200);
    assert.deepEqual(structure.body.history.map(row => row.id), [`manual:${manualId}`, `email:${latest.messageId}`, `email:${first.messageId}`]);
    assert.deepEqual(structure.body.history.map(row => row.kind), ['manual', 'email', 'email']);
    assert.deepEqual(structure.body.history[0].messageIds, []);
    assert.deepEqual(structure.body.history[0].messages, []);
    assert.deepEqual(structure.body.history[1].messageIds, [latest.messageId]);
    assert.equal(structure.body.history[1].messages[0].subject, latest.message.subject);
    assert.equal(structure.body.history[1].status, '测评中');
    assert.equal(structure.body.history[1].recordedAt, latest.message.receivedAt);
    assert.deepEqual(structure.body.history[2].messageIds, [first.messageId]);
  });
});

test('split preview displays both resulting histories and summaries without mutating any archive or ownership', async () => {
  await fixture(async ({ database, repository, request }) => {
    const retained = mail(repository, 'preview-retained', { status: '测评中', receivedAt: '2026-09-04T00:00:00.000Z',
      eventStart: '2026-09-05T01:00:00.000Z', eventEnd: '2026-09-06T10:00:00.000Z' });
    const moved1 = mail(repository, 'preview-moved-first', { threadId: retained.id, receivedAt: '2026-09-06T00:00:00.000Z' });
    const moved2 = mail(repository, 'preview-moved-last', { threadId: retained.id, status: '面试', receivedAt: '2026-09-08T00:00:00.000Z',
      eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z' });
    const before = state(database);
    const payload = { historyIds: [`email:${moved1.messageId}`, `email:${moved2.messageId}`],
      company: COMPANY, position: '示例业务培训生-产品', expectedUpdatedAt: repository.getThread(retained.id).updatedAt };
    const preview = await request(`/api/progress/${retained.id}/split-preview`, payload);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.original.history.map(row => row.id), [`email:${retained.messageId}`]);
    assert.equal(preview.body.original.status, '测评中');
    assert.equal(preview.body.original.eventStart, retained.analysis.eventStart);
    assert.equal(preview.body.original.emailCount, 1);
    assert.equal(preview.body.original.manualCount, 0);
    assert.deepEqual(new Set(preview.body.newApplication.history.map(row => row.id)), new Set(payload.historyIds));
    assert.equal(preview.body.newApplication.position, payload.position);
    assert.equal(preview.body.newApplication.status, '面试');
    assert.equal(preview.body.newApplication.eventStart, moved2.analysis.eventStart);
    assert.equal(preview.body.newApplication.eventEnd, moved2.analysis.eventEnd);
    assert.equal(preview.body.newApplication.emailCount, 2);
    assert.equal(preview.body.newApplication.manualCount, 0);
    assert.equal(preview.body.expectedUpdatedAt, repository.getThread(retained.id).updatedAt);
    assert.deepEqual(state(database), before);
    const saved = await request(`/api/progress/${retained.id}/split`, { ...payload, expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, preview.body.newApplication.status);
    assert.equal(saved.body.eventStart, preview.body.newApplication.eventStart);
    assert.equal(repository.getThread(retained.id).status, preview.body.original.status);
    assert.deepEqual(ownedMailIds(repository, saved.body.id), [moved1.messageId, moved2.messageId].sort((a,b)=>a-b));
  });
});

test('history selection rejects mixed foreign ids and stale previews atomically', async () => {
  await fixture(async ({ database, repository, request }) => {
    const kept = mail(repository, 'selection-kept');
    const moved = mail(repository, 'selection-moved', { threadId: kept.id, receivedAt: '2026-09-03T00:00:00.000Z', status: '面试' });
    const foreign = mail(repository, 'selection-foreign', { position: '另一申请' });
    const payload = { historyIds: [`email:${moved.messageId}`], company: COMPANY, position: '新独立岗位' };
    for (const historyIds of [[`email:${moved.messageId}`,`email:${foreign.messageId}`], ['organization:1'], [`manual:${foreign.messageId}`]]) {
      const before = state(database);
      const preview = await request(`/api/progress/${kept.id}/split-preview`, { ...payload, historyIds });
      assert.equal(preview.status, 400);
      const split = await request(`/api/progress/${kept.id}/split`, { ...payload, historyIds });
      assert.equal(split.status, 400);
      assert.deepEqual(state(database), before);
    }
    const preview = await request(`/api/progress/${kept.id}/split-preview`, payload);
    assert.equal(preview.status, 200);
    const fresh = mail(repository, 'selection-after-preview', { threadId: kept.id, receivedAt: '2026-09-04T00:00:00.000Z' });
    const before = state(database);
    const split = await request(`/api/progress/${kept.id}/split`, { ...payload, expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(split.status, 409);
    assert.equal(split.body.code, 'PROGRESS_STALE');
    assert.deepEqual(state(database), before);
    assert.deepEqual(ownedMailIds(repository, kept.id), [kept.messageId, moved.messageId, fresh.messageId].sort((a,b)=>a-b));
  });
});

test('merge retains original groups and restoring them returns every mail and genuine record to its original application', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route1 = mail(repository, 'restore-route-first');
    const route2 = mail(repository, 'restore-route-last', { threadId: route1.id, status: '测评中', receivedAt: '2026-09-04T00:00:00.000Z' });
    const product1 = mail(repository, 'restore-product-first', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    const product2 = mail(repository, 'restore-product-last', { threadId: product1.id, position: '示例业务培训生-产品', status: '面试',
      receivedAt: '2026-09-08T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z' });
    repository.applyManualProgress({ threadId: product1.id, company: COMPANY, position: product1.analysis.position,
      status: 'Offer', receivedAt: '2026-09-09T00:00:00.000Z', eventStart: '2026-09-09T00:00:00.000Z' });
    const genuineId = repository.listManualProgress(product1.id)[0].id;
    const beforeArchive = archives(database);
    const merged = await request('/api/progress/merge', { targetId: route1.id, sourceIds: [product1.id] });
    assert.equal(merged.status, 200);
    const structure = await request(`/api/progress/${route1.id}/structure`);
    assert.equal(structure.status, 200);
    assert.equal(structure.body.restore.available, true);
    const routeGroup = structure.body.groups.find(group => group.id === route1.id);
    const productGroup = structure.body.groups.find(group => group.id === product1.id);
    assert.ok(routeGroup && productGroup);
    assert.deepEqual(new Set(routeGroup.historyIds), new Set([`email:${route1.messageId}`,`email:${route2.messageId}`]));
    assert.deepEqual(new Set(productGroup.historyIds), new Set([`email:${product1.messageId}`,`email:${product2.messageId}`,`manual:${genuineId}`]));
    assert.equal(routeGroup.position, route1.analysis.position);
    assert.equal(productGroup.position, product1.analysis.position);
    const beforePreview = state(database);
    const preview = await request(`/api/progress/${route1.id}/restore-preview`, { mergeEventId: structure.body.restore.eventId });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.groups.find(group => group.id === route1.id).emailCount, 2);
    assert.equal(preview.body.groups.find(group => group.id === route1.id).manualCount, 0);
    assert.equal(preview.body.groups.find(group => group.id === product1.id).emailCount, 2);
    assert.equal(preview.body.groups.find(group => group.id === product1.id).manualCount, 1);
    assert.deepEqual(state(database), beforePreview);
    const restored = await request(`/api/progress/${route1.id}/restore`, { mergeEventId: preview.body.mergeEventId,
      expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(restored.status, 200);
    assert.deepEqual(numericIds(restored.body.restored), [route1.id, product1.id].sort((a,b)=>a-b));
    assert.deepEqual(numericIds(repository.listThreads()), [route1.id, product1.id].sort((a,b)=>a-b));
    assert.deepEqual(ownedMailIds(repository, route1.id), [route1.messageId, route2.messageId].sort((a,b)=>a-b));
    assert.deepEqual(ownedMailIds(repository, product1.id), [product1.messageId, product2.messageId].sort((a,b)=>a-b));
    assert.deepEqual(numericIds(repository.listManualProgress(product1.id)), [genuineId]);
    assert.deepEqual(repository.listManualProgress(route1.id), []);
    assert.equal(repository.getThread(route1.id).status, '测评中');
    assert.equal(repository.getThread(route1.id).position, route1.analysis.position);
    assert.equal(repository.getThread(product1.id).status, 'Offer');
    assert.equal(repository.getThread(product1.id).position, product1.analysis.position);
    assert.equal(manualCount(database), 1);
    assert.deepEqual(archives(database), beforeArchive);
    assert.deepEqual(numericIds(repository.listManualThreadRoutesForMessage(product2.messageId)), [product1.id]);
  });
});

test('restoration refuses a stale merge preview after new real correspondence changes its membership', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route = mail(repository, 'stale-restore-route');
    const product = mail(repository, 'stale-restore-product', { position: '示例业务培训生-产品', receivedAt: '2026-09-02T00:00:00.000Z' });
    await request('/api/progress/merge', { targetId: route.id, sourceIds: [product.id] });
    const structure = await request(`/api/progress/${route.id}/structure`);
    assert.equal(structure.status, 200);
    const preview = await request(`/api/progress/${route.id}/restore-preview`, { mergeEventId: structure.body.restore.eventId });
    assert.equal(preview.status, 200);
    const fresh = mail(repository, 'stale-restore-fresh', { threadId: route.id, receivedAt: '2026-09-04T00:00:00.000Z' });
    const before = state(database);
    const restored = await request(`/api/progress/${route.id}/restore`, { mergeEventId: preview.body.mergeEventId,
      expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(restored.status, 409);
    assert.equal(restored.body.code, 'PROGRESS_STALE');
    assert.deepEqual(state(database), before);
    assert.deepEqual(ownedMailIds(repository, route.id), [route.messageId, product.messageId, fresh.messageId].sort((a,b)=>a-b));
  });
});

test('reopening legacy merged data hides technical snapshots without deleting a genuine manual record or inventing restore groups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-progress-history-'));
  const file = join(directory, 'fixture.sqlite');
  let database = createDatabase(file);
  try {
    let repository = createMessageRepository(database.db);
    const route = mail(repository, 'legacy-route');
    const product = mail(repository, 'legacy-product', { position: '示例业务培训生-产品', status: '面试', receivedAt: '2026-09-08T00:00:00.000Z',
      eventStart: '2026-09-12T02:00:00.000Z' });
    const originalRows = [repository.getThread(route.id), repository.getThread(product.id)];
    database.db.prepare('UPDATE application_threads SET merged_into_thread_id=? WHERE id=?').run(route.id, product.id);
    database.db.prepare('INSERT INTO application_thread_messages(thread_id,message_id,linked_at) VALUES(?,?,?)')
      .run(route.id, product.messageId, product.message.receivedAt);
    database.db.prepare('DELETE FROM application_thread_messages WHERE thread_id=?').run(product.id);
    repository.applyManualProgress({ threadId: route.id, company: COMPANY, position: route.analysis.position, status: 'Offer',
      receivedAt: '2026-09-13T00:00:00.000Z', eventStart: '2026-09-13T00:00:00.000Z' });
    const genuine = repository.listManualProgress(route.id)[0];
    const technicalTime = '2026-09-15T00:00:00.000Z';
    repository.updateThread(route.id, { company: COMPANY, position: route.analysis.position, status: '面试',
      eventStart: product.analysis.eventStart, eventEnd: null, notes: null, manualUpdatedAt: technicalTime });
    database.db.prepare('UPDATE application_threads SET latest_message_id=?,latest_received_at=? WHERE id=?')
      .run(product.messageId, product.message.receivedAt, route.id);
    const after = repository.getThread(route.id);
    const technical = database.db.prepare(`INSERT INTO manual_progress_events
      (thread_id,company,position,status,event_start,event_end,notes,recorded_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(route.id, after.company, after.position, after.status, after.eventStart, after.eventEnd, after.notes, technicalTime);
    const technicalId = Number(technical.lastInsertRowid);
    database.db.prepare('INSERT INTO application_structure_events(kind,source_ids,target_thread_id,detail_json,recorded_at) VALUES(?,?,?,?,?)')
      .run('merge', JSON.stringify([product.id]), route.id,
        JSON.stringify({ before: originalRows, after, messageIds: [route.messageId, product.messageId] }), technicalTime);
    const beforeArchive = archives(database);
    database.close();
    database = createDatabase(file);
    repository = createMessageRepository(database.db);
    const structure = repository.getThreadStructure(route.id);
    assert.deepEqual(new Set(structure.history.map(row => row.id)), new Set([`email:${route.messageId}`, `email:${product.messageId}`, `manual:${genuine.id}`]));
    assert.ok(!structure.history.some(row => row.id === `manual:${technicalId}`));
    assert.equal(database.db.prepare('SELECT entry_kind AS kind FROM manual_progress_events WHERE id=?').get(technicalId).kind, 'organization');
    assert.equal(database.db.prepare('SELECT entry_kind AS kind FROM manual_progress_events WHERE id=?').get(genuine.id).kind, 'manual');
    assert.equal(manualCount(database), 2, 'legacy technical evidence remains archived rather than deleted');
    assert.equal(structure.restore.available, false, 'old logs without explicit complete members cannot promise automatic restoration');
    assert.ok(structure.restore.reason);
    assert.equal(repository.getThread(route.id).status, 'Offer', 'after hiding the technical snapshot, the list summary must agree with the real history');
    assert.equal(repository.getThread(route.id).progressUpdatedAt, genuine.recordedAt, 'technical operation time cannot remain the application progress date');
    assert.deepEqual(archives(database), beforeArchive);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('renaming an application with an unknown event date preserves unknown time through the API', async () => {
  await fixture(async ({ database,repository,request }) => {
    const source=mail(repository,'unknown-event-rename',{eventStart:null,eventEnd:null});
    repository.updateThread(source.id,{eventStart:null,eventEnd:null});
    const before=repository.getThread(source.id);
    const edited=await request(`/api/progress/${source.id}`,{company:'更正后的公司',position:before.position,
      status:before.status,eventStart:null,eventEnd:null,notes:before.notes},'PUT');
    assert.equal(edited.status,200);
    assert.equal(edited.body.eventStart,null);
    assert.equal(edited.body.eventEnd,null);
    assert.equal(edited.body.progressUpdatedAt,before.progressUpdatedAt);
    assert.equal(manualCount(database),0);
  });
});

test('an email correction made after merge follows its correspondence when restoring the original groups', async () => {
  await fixture(async ({ database, repository, request }) => {
    const route = mail(repository, 'correction-restore-route');
    const product = mail(repository, 'correction-restore-product', { position: '示例业务培训生-产品', status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z' });
    await request('/api/progress/merge', { targetId: route.id, sourceIds: [product.id] });
    const corrected = await request(`/api/progress/${route.id}`, { company: COMPANY, position: route.analysis.position,
      status: '面试', eventStart: '2026-09-12T02:00:00.000Z', notes: 'https://meeting.example.test/after-merge' }, 'PUT');
    assert.equal(corrected.status, 200);
    const structure = await request(`/api/progress/${route.id}/structure`);
    assert.equal(structure.body.history.find(row => row.id === `email:${product.messageId}`).status, '面试');
    const preview = await request(`/api/progress/${route.id}/restore-preview`, { mergeEventId: structure.body.restore.eventId });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.groups.find(group => group.id === product.id).status, '面试', 'the correction belongs to its mail, not whichever application currently contains it');
    const result = await request(`/api/progress/${route.id}/restore`, { mergeEventId: preview.body.mergeEventId,
      expectedUpdatedAt: preview.body.expectedUpdatedAt });
    assert.equal(result.status, 200);
    assert.equal(repository.getThread(product.id).status, '面试');
    assert.equal(repository.getThread(product.id).eventStart, '2026-09-12T02:00:00.000Z');
    assert.equal(repository.getThread(route.id).status, route.analysis.status);
    const correction = database.db.prepare("SELECT thread_id AS threadId FROM manual_progress_events WHERE entry_kind='correction' AND message_id=? ORDER BY id DESC LIMIT 1").get(product.messageId);
    assert.equal(correction.threadId, product.id);
    assert.equal(manualCount(database), 1);
    assert.deepEqual(numericIds(repository.listManualThreadRoutesForMessage(product.messageId)), [product.id]);
  });
});

test('model replay cannot replace a confirmed email correction in the application summary', async () => {
  await fixture(async ({ repository, request }) => {
    const route = mail(repository, 'correction-replay-route');
    const product = mail(repository, 'correction-replay-product', { position: '示例业务培训生-产品', status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z' });
    await request('/api/progress/merge', { targetId: route.id, sourceIds: [product.id] });
    const corrected = await request(`/api/progress/${route.id}`, { company: COMPANY, position: route.analysis.position,
      status: '面试', eventStart: '2026-09-12T02:00:00.000Z', notes: 'https://meeting.example.test/confirmed' }, 'PUT');
    assert.equal(corrected.status, 200);
    const service = createSyncService({ repository, analysisVersion: 'journey-correction-replay-v2',
      triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...product.analysis, status: 'Offer',
        company: '错误模型公司', position: '错误模型岗位', threadRef: 'new' }) });
    await service.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z', messages: [product.message] });
    const structure = await request(`/api/progress/${route.id}/structure`);
    assert.equal(structure.body.history[0].status, '面试');
    assert.equal(repository.getThread(route.id).status, '面试');
    assert.equal(repository.getThread(route.id).eventStart, '2026-09-12T02:00:00.000Z');
    assert.equal(repository.getThread(route.id).progressUpdatedAt, product.message.receivedAt);
    assert.equal(repository.getThread(route.id).company, COMPANY);
    assert.deepEqual(numericIds(repository.listThreads()), [route.id]);
  });
});

test('legacy organization migration cannot hide a matching genuine record in a different application', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-mail-progress-migration-scope-'));
  const file = join(directory, 'fixture.sqlite');
  let database = createDatabase(file);
  try {
    let repository = createMessageRepository(database.db);
    const target = mail(repository, 'migration-scope-target');
    const after = repository.getThread(target.id);
    const technicalTime = '2026-09-15T00:00:00.000Z';
    const technicalId = Number(database.db.prepare(`INSERT INTO manual_progress_events
      (thread_id,company,position,status,event_start,event_end,notes,recorded_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(target.id,after.company,after.position,after.status,after.eventStart,after.eventEnd,after.notes,technicalTime).lastInsertRowid);
    database.db.prepare('INSERT INTO application_structure_events(kind,source_ids,target_thread_id,detail_json,recorded_at) VALUES(?,?,?,?,?)')
      .run('merge','[]',target.id,JSON.stringify({before:[after],after,messageIds:[target.messageId]}),technicalTime);
    const genuineThread = repository.applyManualProgress({ accountId: 'another-journey@example.test',
      company: after.company, position: after.position, status: after.status, eventStart: after.eventStart,
      eventEnd: after.eventEnd, notes: after.notes, receivedAt: technicalTime });
    const genuineId = repository.listManualProgress(genuineThread.id)[0].id;
    database.close();
    database = createDatabase(file);
    repository = createMessageRepository(database.db);
    assert.equal(database.db.prepare('SELECT entry_kind AS kind FROM manual_progress_events WHERE id=?').get(technicalId).kind, 'organization');
    assert.equal(database.db.prepare('SELECT entry_kind AS kind FROM manual_progress_events WHERE id=?').get(genuineId).kind, 'manual');
    assert.equal(repository.getThreadStructure(genuineThread.id).history[0].id, `manual:${genuineId}`);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a pure company correction remains authoritative during replay without becoming a manual recruitment event', async () => {
  await fixture(async ({ database, repository, request }) => {
    const source = mail(repository, 'identity-company-replay', { company: '未识别公司', status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z' });
    repository.updateThread(source.id, { needsReview: true });
    const old = repository.getThread(source.id);
    const corrected = await request(`/api/progress/${source.id}`, { company: '用户确认的公司', position: old.position,
      status: old.status, eventStart: old.eventStart, eventEnd: old.eventEnd, notes: old.notes }, 'PUT');
    assert.equal(corrected.status, 200);
    assert.equal(manualCount(database), 0);
    assert.equal(corrected.body.manualUpdatedAt, null);
    assert.equal(corrected.body.manualPositionOverride, false, 'confirming company identity does not claim a position override');
    const service = createSyncService({ repository, analysisVersion: 'journey-company-confirmation-v2',
      triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...source.analysis, threadRef: 'new' }) });
    await service.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z', messages: [source.message] });
    assert.deepEqual(numericIds(repository.listThreads()), [source.id]);
    assert.equal(repository.getThread(source.id).company, '用户确认的公司');
    assert.equal(repository.getThread(source.id).needsReview, false);
    assert.equal(repository.getThread(source.id).progressUpdatedAt, old.progressUpdatedAt);
    assert.deepEqual(ownedMailIds(repository, source.id), [source.messageId]);
    assert.equal(manualCount(database), 0);
  });
});

test('fresh correspondence advances a corrected application while replaying old pinned mail leaves the latest genuine progress intact', async () => {
  await fixture(async ({ database, repository, request }) => {
    const old = mail(repository, 'fresh-after-identity-old', { company: '未识别公司', status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z' });
    const corrected = await request(`/api/progress/${old.id}`, { company: '已确认公司', position: old.analysis.position,
      status: old.analysis.status, eventStart: old.analysis.eventStart, notes: old.analysis.notes }, 'PUT');
    assert.equal(corrected.status, 200);
    const fresh = { ...old.message, messageKey: `journey|${ACCOUNT}|fresh-after-identity-new`,
      messageId: '<fresh-after-identity-new@journey.example.test>', uid: 'fresh-after-identity-new',
      receivedAt: '2026-09-08T00:00:00.000Z', subject: '已确认公司 面试邀请', text: '新的真实面试进度通知' };
    const service = createSyncService({ repository, analysisVersion: 'journey-new-after-confirmation-v2',
      triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...old.analysis, company: '已确认公司',
        status: '面试', eventStart: '2026-09-12T02:00:00.000Z', threadRef: old.id }) });
    await service.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z', messages: [fresh] });
    const head = repository.getThread(old.id);
    assert.equal(head.status, '面试');
    assert.equal(head.progressUpdatedAt, fresh.receivedAt);
    assert.equal(head.eventStart, '2026-09-12T02:00:00.000Z');
    assert.equal(head.manualUpdatedAt, null);
    assert.equal(head.manualPositionOverride, false);
    const replay = createSyncService({ repository, analysisVersion: 'journey-old-after-new-v3',
      triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...old.analysis, company: '错误模型公司',
        status: 'Offer', threadRef: 'new' }) });
    await replay.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z', messages: [old.message] });
    assert.equal(repository.getThread(old.id).status, '面试');
    assert.equal(repository.getThread(old.id).company, '已确认公司');
    assert.equal(repository.getThread(old.id).progressUpdatedAt, fresh.receivedAt);
    assert.equal(repository.getThreadStructure(old.id).history[0].status, '面试');
    assert.equal(repository.getThreadStructure(old.id).history.find(entry => entry.id === `email:${old.messageId}`).status, '测评中');
    assert.equal(manualCount(database), 0);
    assert.equal(repository.listThreadMessages(old.id).length, 2);
  });
});

test('confirming company identity on a shared mail protects the complete owner set during model replay', async () => {
  await fixture(async ({ database, repository, request }) => {
    const first = mail(repository, 'shared-identity-first', { company: '未识别公司', status: '测评中',
      receivedAt: '2026-09-04T00:00:00.000Z', eventStart: '2026-09-05T01:00:00.000Z' });
    const sibling = mail(repository, 'shared-identity-sibling', { position: 'IT产品类', receivedAt: '2026-09-02T00:00:00.000Z' });
    repository.upsertThreadFromMessage({ threadId: sibling.id, accountId: ACCOUNT, company: COMPANY, position: sibling.analysis.position,
      status: first.analysis.status, eventStart: first.analysis.eventStart, confidence: .9, receivedAt: first.message.receivedAt, messageId: first.messageId });
    repository.linkMessageToThread(sibling.id, first.messageId);
    const corrected = await request(`/api/progress/${first.id}`, { company: '已确认公司', position: first.analysis.position,
      status: first.analysis.status, eventStart: first.analysis.eventStart, notes: first.analysis.notes }, 'PUT');
    assert.equal(corrected.status, 200);
    assert.deepEqual(numericIds(repository.listManualThreadRoutesForMessage(first.messageId)), [first.id, sibling.id].sort((a,b)=>a-b));
    const service = createSyncService({ repository, analysisVersion: 'journey-shared-identity-v2',
      triage: () => ({ decision: 'analyze' }), classifier: async () => ({ ...first.analysis, status: 'Offer',
        company: '错误模型公司', appliesToAll: true, threadRef: 'new' }) });
    await service.syncMessages({ accountId: ACCOUNT, source: 'fixture', from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z', messages: [first.message] });
    assert.deepEqual(ownedMailIds(repository, first.id), [first.messageId]);
    assert.deepEqual(ownedMailIds(repository, sibling.id), [first.messageId, sibling.messageId].sort((a,b)=>a-b));
    assert.equal(repository.getThread(first.id).company, '已确认公司');
    assert.equal(repository.getThread(first.id).status, '测评中');
    assert.equal(repository.getThread(sibling.id).company, COMPANY);
    assert.equal(repository.getThread(sibling.id).position, sibling.analysis.position);
    assert.equal(repository.getThread(sibling.id).status, '测评中');
    assert.equal(manualCount(database), 0);
  });
});
