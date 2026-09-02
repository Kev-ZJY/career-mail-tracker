import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository, runBackfillIfNeeded } from '../src/db.js';

let database;

afterEach(() => {
  database?.close();
  database = undefined;
});

function memoryRepo() {
  const db = createDatabase(':memory:');
  return createMessageRepository(db.db);
}

function memoryRepoWithBackfill(messages) {
  // Create DB and insert messages directly, then create repo (which triggers backfill)
  const db = createDatabase(':memory:');
  const insertStmt = db.db.prepare(`
    INSERT INTO mail_messages (
      message_key, message_id, account_id, provider, folder, received_at, sender, subject,
      content_hash, analysis_version, is_job_related, company, position, status,
      confidence, evidence, next_action, needs_review, analyzed_at,
      event_start, event_end, notes, web_url, body_text, body_html, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const m of messages) {
    insertStmt.run(
      m.messageKey, m.messageId || null, m.accountId, m.provider, m.folder,
      m.receivedAt, m.sender, m.subject, m.contentHash, m.analysisVersion,
      m.analysis.isJobRelated ? 1 : 0, m.analysis.company, m.analysis.position,
      m.analysis.status, m.analysis.confidence, m.analysis.evidence,
      m.analysis.nextAction, m.analysis.needsReview ? 1 : 0, m.analyzedAt,
      m.analysis.eventStart || null, m.analysis.eventEnd || null,
      m.analysis.notes || null, m.webUrl || null, m.bodyText || null, m.bodyHtml || null,
      m.source || 'email'
    );
  }
  // Now run backfill explicitly
  runBackfillIfNeeded(db.db);
  return createMessageRepository(db.db);
}

test('dashboard repository hides non-job analyses by default but keeps an explicit diagnostic escape hatch', () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const base = {
    accountId: 'demo@qq.com', provider: 'qq', folder: 'INBOX', receivedAt: '2026-08-21T00:00:00.000Z',
    sender: 'sender@example.test', subject: '邮件', contentHash: 'hash', analysisVersion: 'v1',
    analyzedAt: '2026-08-21T00:00:00.000Z', messageId: null, webUrl: null,
  };

  repository.saveAnalysis({
    ...base,
    messageKey: 'job',
    analysis: { isJobRelated: true, company: '示例科技', position: '工程师', status: '面试', confidence: 0.9, evidence: '面试', nextAction: '准备', needsReview: false },
  });
  repository.saveAnalysis({
    ...base,
    messageKey: 'ad',
    contentHash: 'hash-ad',
    analysis: { isJobRelated: false, company: '', position: '', status: '已结束', confidence: 0.2, evidence: '广告', nextAction: '忽略', needsReview: true },
  });

  assert.equal(repository.listAnalyses().length, 1);
  assert.equal(repository.listAnalyses({ jobRelatedOnly: false }).length, 2);
  assert.deepEqual(repository.getCounts(), { 面试: 1 });
});

test('database migration removes legacy statuses from the active progress contract', () => {
  database = createDatabase(':memory:');
  database.db.exec(`
    INSERT INTO mail_messages (
      message_key, account_id, provider, folder, received_at, sender, subject,
      content_hash, analysis_version, is_job_related, company, position, status,
      confidence, evidence, next_action, needs_review, analyzed_at
    ) VALUES
      ('legacy-pending', 'demo', 'qq', 'INBOX', '2026-08-21T00:00:00.000Z', 's', 'pending', 'p', 'v1', 1, '', '', '待确认', 0.2, '旧状态', '旧动作', 1, '2026-08-21T00:00:00.000Z'),
      ('legacy-rejected', 'demo', 'qq', 'INBOX', '2026-08-20T00:00:00.000Z', 's', 'rejected', 'r', 'v1', 1, '示例公司', '工程师', '拒绝', 0.9, '未通过', '归档', 0, '2026-08-20T00:00:00.000Z'),
      ('legacy-screening', 'demo', 'qq', 'INBOX', '2026-08-19T00:00:00.000Z', 's', 'screening', 's', 'v1', 1, '另一公司', '工程师', '筛选中', 0.8, '筛选', '等待', 0, '2026-08-19T00:00:00.000Z')
  `);

  const migrated = createMessageRepository(database.db);
  assert.deepEqual(migrated.listAnalyses().map((row) => [row.status, row.isJobRelated]), [
    ['已结束', true],
    ['已投递', true],
  ]);
  assert.deepEqual(migrated.listAnalyses({ jobRelatedOnly: false }).map((row) => [row.status, row.isJobRelated]), [
    ['已结束', false],
    ['已结束', true],
    ['已投递', true],
  ]);
});

test('legacy mail messages are backfilled into application threads keeping the latest event', () => {
  const messages = [
    {
      messageKey: 'k-2026-03-01T00:00:00Z', accountId: 'a', provider: 'qq', folder: 'INBOX',
      receivedAt: '2026-03-01T00:00:00Z', sender: 'hr@x.com', subject: '通知', contentHash: '2026-03-01T00:00:00Z', analysisVersion: 'v',
      analysis: { isJobRelated: true, company: '甲科技', position: '后端', status: '已投递', confidence: .9,
        evidence: 'e', nextAction: 'n', needsReview: false }, analyzedAt: '2026-03-01T00:00:00Z',
    },
    {
      messageKey: 'k-2026-04-10T00:00:00Z', accountId: 'a', provider: 'qq', folder: 'INBOX',
      receivedAt: '2026-04-10T00:00:00Z', sender: 'hr@x.com', subject: '通知', contentHash: '2026-04-10T00:00:00Z', analysisVersion: 'v',
      analysis: { isJobRelated: true, company: '甲科技', position: '后端', status: '面试', confidence: .9,
        evidence: 'e', nextAction: 'n', needsReview: false }, analyzedAt: '2026-04-10T00:00:00Z',
    },
  ];
  const repo = memoryRepoWithBackfill(messages);
  const threads = repo.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, '面试');
  assert.equal(threads[0].latestReceivedAt, '2026-04-10T00:00:00Z');
});
test('backfill keeps one thread per company+position even when two mails share the exact same timestamp', () => {
  const mk = (key, status) => ({
    messageKey: key, accountId: 'a', provider: 'qq', folder: 'INBOX',
    receivedAt: '2026-07-23T11:33:51.000Z', sender: 'hr@x.com', subject: '面试邀请反馈', contentHash: key, analysisVersion: 'v',
    analysis: { isJobRelated: true, company: '腾讯', position: '产品策划', status, confidence: .9,
      evidence: 'e', nextAction: 'n', needsReview: false }, analyzedAt: '2026-07-23T11:33:51.000Z',
  });
  const repo = memoryRepoWithBackfill([mk('k-t1', '面试'), mk('k-t2', '面试')]);
  const threads = repo.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].company, '腾讯');
  assert.equal(threads[0].position, '产品策划');
  assert.equal(threads[0].latestReceivedAt, '2026-07-23T11:33:51.000Z');
});

test('re-analysis without a body payload keeps the stored mail body intact', () => {
  database = createDatabase(':memory:');
  const repo = createMessageRepository(database.db);
  const analysis = { isJobRelated: true, company: '甲', position: '后端', status: '面试', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false };
  repo.saveAnalysis({
    messageKey: 'k-body', accountId: 'a', provider: 'qq', folder: 'INBOX', receivedAt: '2026-01-01T00:00:00Z',
    sender: 's', subject: '面试', contentHash: 'h1', analysisVersion: 'v1', analyzedAt: '2026-01-01T00:00:00Z',
    bodyText: '原始正文文本', bodyHtml: '<p>原始HTML</p>', analysis,
  }, undefined);
  // 重分析：不携带 body（如离线重放脚本），正文必须保留
  const existing = database.db.prepare("SELECT * FROM mail_messages WHERE message_key = 'k-body'").get();
  repo.saveAnalysis({
    messageKey: 'k-body', accountId: 'a', provider: 'qq', folder: 'INBOX', receivedAt: '2026-01-01T00:00:00Z',
    sender: 's', subject: '面试', contentHash: 'h2', analysisVersion: 'v2', analyzedAt: '2026-01-02T00:00:00Z',
    analysis: { ...analysis, status: 'Offer' },
  }, existing);
  const row = database.db.prepare("SELECT body_text, body_html FROM mail_messages WHERE message_key = 'k-body'").get();
  assert.equal(row.body_text, '原始正文文本');
  assert.equal(row.body_html, '<p>原始HTML</p>');
});

test('backfill rerun after deleting the marker does not accumulate duplicate threads', () => {
  database = createDatabase(':memory:');
  const repo = createMessageRepository(database.db);
  const mk = (key) => ({
    messageKey: key, accountId: 'a', provider: 'qq', folder: 'INBOX',
    receivedAt: '2026-05-01T00:00:00Z', sender: 'hr@x.com', subject: '投递成功 - 职位A', contentHash: key, analysisVersion: 'v',
    analysis: { isJobRelated: true, company: '腾讯', position: '产品策划', status: '已投递', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, analyzedAt: '2026-05-01T00:00:00Z',
  });
  repo.saveAnalysis(mk('k1'), undefined);
  repo.saveAnalysis(mk('k2'), undefined);
  runBackfillIfNeeded(database.db);
  const first = database.db.prepare('SELECT COUNT(*) AS n FROM application_threads').get().n;
  // 删标记触发二次回填：应清空重建而非累积
  database.db.prepare("DELETE FROM settings WHERE key = 'threads.backfill.v1'").run();
  runBackfillIfNeeded(database.db);
  const second = database.db.prepare('SELECT COUNT(*) AS n FROM application_threads').get().n;
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test('backfill drops orphan empty-position threads when the company has a named thread', () => {
  database = createDatabase(':memory:');
  const repo = createMessageRepository(database.db);
  const mk = (key, position, status, at) => ({
    messageKey: key, accountId: 'a', provider: 'qq', folder: 'INBOX',
    receivedAt: at, sender: 'hr@x.com', subject: `通知-${key}`, contentHash: key, analysisVersion: 'v',
    analysis: { isJobRelated: true, company: '腾讯', position, status, confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, analyzedAt: at,
  });
  // 6/23 产品策划面试 + 6/25 无岗位反馈问卷（同一公司）
  repo.saveAnalysis(mk('k-0623', '产品策划', '面试', '2026-06-23T14:16:00.000Z'), undefined);
  repo.saveAnalysis(mk('k-0625', '', '已结束', '2026-06-25T09:10:00.000Z'), undefined);
  runBackfillIfNeeded(database.db);
  const threads = repo.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].position, '产品策划');
});
