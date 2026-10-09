import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';

const ACCOUNT = 'manual-semantics@example.test';
const COMPANY = '进展语义测试公司';

function fixture(run) {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  try { run({ database, repository }); }
  finally { database.close(); }
}

function email(repository, key, { threadId, receivedAt = '2026-09-04T00:00:00.000Z', status = '测评中' } = {}) {
  const progress = { company: COMPANY, position: '测试岗位', status, eventStart: '2026-09-05T01:00:00.000Z',
    eventEnd: '2026-09-06T10:00:00.000Z', notes: null, confidence: .9, needsReview: false, evidence: key, nextAction: '' };
  const message = repository.saveAnalysis({ messageKey: `semantics|${key}`, messageId: `<${key}@example.test>`,
    accountId: ACCOUNT, provider: 'qq', folder: 'INBOX', sender: 'hr@example.test', subject: `招聘 ${key}`,
    receivedAt, contentHash: key, analysisVersion: 'semantics-v1', analyzedAt: receivedAt, bodyText: `原邮件 ${key}`,
    analysis: { ...progress, isJobRelated: true } });
  const id = Number(repository.upsertThreadFromMessage({ ...progress, threadId, accountId: ACCOUNT, receivedAt, messageId: message.id }));
  repository.linkMessageToThread(id, message.id, receivedAt);
  return { id, messageId: message.id };
}

test('identity-only edit preserves actual progress date and does not create manual history', () => fixture(({ database, repository }) => {
  const source = email(repository, 'identity');
  const before = repository.getThread(source.id);
  const edited = repository.applyManualProgress({ ...before, threadId: source.id, intent: 'edit',
    company: '确认后的测试公司', position: '确认后的测试岗位',
    eventStart: '2026-09-05T01:00Z', eventEnd: '2026-09-06T10:00Z' });
  assert.equal(edited.company, '确认后的测试公司');
  assert.equal(edited.position, '确认后的测试岗位');
  assert.equal(edited.progressUpdatedAt, before.progressUpdatedAt);
  assert.equal(edited.manualUpdatedAt, before.manualUpdatedAt);
  assert.notEqual(edited.updatedAt, before.updatedAt);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM manual_progress_events').get().n, 0);
}));

test('correcting an email edits its associated history and follows that email when split', () => fixture(({ database, repository }) => {
  const early = email(repository, 'earlier', { receivedAt: '2026-09-01T00:00:00.000Z', status: '已投递' });
  const latest = email(repository, 'latest', { threadId: early.id });
  const before = repository.getThread(early.id);
  const originalArchives = database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all();
  const edited = repository.applyManualProgress({ ...before, threadId: early.id, intent: 'edit', status: '面试',
    eventStart: '2026-09-12T02:00:00.000Z', eventEnd: '2026-09-12T03:00:00.000Z',
    notes: 'https://meeting.example.test/corrected' });
  assert.equal(edited.status, '面试');
  assert.equal(edited.progressUpdatedAt, before.progressUpdatedAt);
  assert.equal(edited.manualUpdatedAt, before.manualUpdatedAt);
  assert.deepEqual(repository.listManualProgress(early.id), [], 'email corrections do not become a separate manual record');
  const correction = database.db.prepare('SELECT id, entry_kind, message_id FROM manual_progress_events WHERE thread_id=?').get(early.id);
  assert.equal(correction.entry_kind, 'correction');
  assert.equal(correction.message_id, latest.messageId);
  const child = repository.splitThread({ threadId: early.id, messageIds: [latest.messageId], company: COMPANY, position: '拆出的测试岗位' });
  assert.equal(child.status, '面试');
  assert.equal(child.notes, 'https://meeting.example.test/corrected');
  assert.equal(database.db.prepare('SELECT thread_id FROM manual_progress_events WHERE id=?').get(correction.id).thread_id, child.id);
  assert.equal(repository.getThread(early.id).status, '已投递');
  assert.deepEqual(repository.listManualProgress(child.id), []);
  assert.deepEqual(database.db.prepare('SELECT * FROM mail_messages ORDER BY id').all(), originalArchives);
}));

test('editing a manual-only progress updates that item in place instead of adding a duplicate', () => fixture(({ database, repository }) => {
  const source = repository.applyManualProgress({ company: COMPANY, position: '手动测试岗位', status: '面试',
    receivedAt: '2026-09-09T00:00:00.000Z', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: null, notes: null });
  const original = repository.listManualProgress(source.id)[0];
  const edited = repository.applyManualProgress({ ...source, threadId: source.id, intent: 'edit', status: 'Offer', eventEnd: null });
  const items = repository.listManualProgress(source.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, original.id);
  assert.equal(items[0].status, 'Offer');
  assert.equal(items[0].recordedAt, original.recordedAt);
  assert.equal(edited.progressUpdatedAt, source.progressUpdatedAt);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM manual_progress_events').get().n, 1);
}));

test('adding genuine manual progress remains a new item and retains its actual entry time', () => fixture(({ database, repository }) => {
  const source = email(repository, 'genuine-manual');
  const updated = repository.applyManualProgress({ ...repository.getThread(source.id), threadId: source.id,
    receivedAt: '2026-09-09T00:00:00.000Z', status: '面试', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: null });
  const manual = repository.listManualProgress(source.id)[0];
  assert.equal(manual.status, '面试');
  assert.equal(updated.progressUpdatedAt, '2026-09-09T00:00:00.000Z');
  const raw = database.db.prepare('SELECT entry_kind, message_id FROM manual_progress_events WHERE id=?').get(manual.id);
  assert.equal(raw.entry_kind, 'manual');
  assert.equal(raw.message_id, null);
}));

test('editing the latest genuine manual record preserves it when the application also has older email', () => fixture(({ database, repository }) => {
  const source = email(repository, 'manual-after-email');
  repository.applyManualProgress({ ...repository.getThread(source.id), threadId: source.id,
    receivedAt: '2026-09-09T00:00:00.000Z', status: '面试', eventStart: '2026-09-12T02:00:00.000Z', eventEnd: null });
  const original = repository.listManualProgress(source.id)[0];
  const before = repository.getThread(source.id);
  const edited = repository.applyManualProgress({ ...before, threadId: source.id, intent: 'edit', status: 'Offer', eventEnd: null });
  const manual = repository.listManualProgress(source.id);
  assert.equal(edited.status, 'Offer');
  assert.equal(edited.progressUpdatedAt, before.progressUpdatedAt);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].id, original.id);
  assert.equal(manual[0].status, 'Offer');
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM manual_progress_events WHERE entry_kind='correction'").get().n, 0);
  assert.equal(database.db.prepare('SELECT status FROM mail_messages WHERE id=?').get(source.messageId).status, '测评中');
}));

test('adding an older genuine manual record keeps newer correspondence as the current application progress', () => fixture(({ repository }) => {
  const source = email(repository, 'newer-email');
  const before = repository.getThread(source.id);
  const edited = repository.applyManualProgress({ ...before, threadId: source.id,
    receivedAt: '2026-09-01T00:00:00.000Z', status: '已投递', eventStart: '2026-09-01T00:00:00.000Z', eventEnd: null });
  assert.equal(edited.status, '测评中');
  assert.equal(edited.progressUpdatedAt, before.progressUpdatedAt);
  assert.equal(repository.listManualProgress(source.id)[0].status, '已投递');
}));
