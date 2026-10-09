// 离线重放（scripts/reanalyze.mjs）的身份契约。
//
// 重放的输入来自库内 body_text，而 content_hash 是按 IMAP 全量正文算的——
// 两者在真实数据里本就不相等（生产库实测 146/284 行不等）。若重放时用存档文本
// 重算指纹并写回，下次真同步会把这些行判为「正文已变」，走冲突分支把同一封
// 邮件复制成一条 |imap| 新记录。
//
// 因此：调用方显式带上库内 messageKey 时，这一行的身份以库内记录为准。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createSyncService } from '../src/services/sync-service.js';
import { triageRecruitmentMessage } from '../src/domain/triage.js';

let database;

afterEach(() => {
  database?.close();
  database = undefined;
});

const from = '2026-08-01T00:00:00.000Z';
const to = '2026-08-31T23:59:59.999Z';
const accountId = 'demo@qq.com';
const analysis = (company) => ({
  isJobRelated: true,
  company,
  position: '后端开发工程师',
  status: '面试',
  confidence: 0.9,
  evidence: '邀请你参加技术面试',
  nextAction: '确认面试时间',
  needsReview: false,
});

// IMAP 侧的完整正文（hash 的真实来源）
const fullText = '公司：示例科技\n职位：后端开发工程师\n我们邀请你参加技术面试，请确认时间。';

// 存档正文：被 clampText 截断后的样子。刻意与 fullText 不同，
// 用来证明重放不会用它覆盖库内指纹。
const archivedText = `${fullText.slice(0, 20)}\n[存档被截断]`;

const imapMessage = {
  accountId,
  provider: 'qq',
  folder: 'INBOX',
  uidValidity: 'demo-1',
  uid: '1001',
  messageId: '<demo-1001@example.test>',
  receivedAt: '2026-08-21T08:30:00.000Z',
  sender: '招聘团队 <recruit@example.test>',
  subject: '示例科技技术面试邀请',
  text: fullText,
};

function buildService(repository, analysisVersion) {
  return createSyncService({
    repository,
    classifier: async () => analysis('示例科技'),
    triage: triageRecruitmentMessage,
    analysisVersion,
  });
}

async function seedRepository() {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  await buildService(repository, 'v1').syncMessages({
    accountId,
    from,
    to,
    messages: [imapMessage],
  });
  const stored = repository.findByKey(`${accountId}|message-id|${imapMessage.messageId}`);
  assert.ok(stored, 'seed message not persisted');
  return { repository, stored };
}

test('replay keeps the stored content hash instead of recomputing it from the archived body', async () => {
  const { repository, stored } = await seedRepository();
  const originalHash = stored.content_hash;
  assert.equal(
    originalHash,
    createHash('sha256').update(`${imapMessage.subject}\n${fullText}`).digest('hex'),
  );
  // 前提：存档正文重算出来的指纹与库内不同（否则本测试是恒真的）。
  const replayHash = createHash('sha256').update(`${imapMessage.subject}\n${archivedText}`).digest('hex');
  assert.notEqual(replayHash, originalHash);

  const summary = await buildService(repository, 'v2').syncMessages({
    accountId,
    from,
    to,
    messages: [{
      messageKey: stored.message_key,
      messageId: stored.message_id,
      provider: stored.provider,
      folder: stored.folder,
      receivedAt: stored.received_at,
      sender: stored.sender,
      subject: stored.subject,
      text: archivedText,
    }],
  });

  assert.equal(summary.analyzed, 1, '版本变了就该重分析');
  const after = repository.findByKey(stored.message_key);
  assert.equal(after.content_hash, originalHash, '重放不得改写库内内容指纹');
  assert.equal(after.analysis_version, 'v2');
});

test('after a replay the same IMAP message is still recognized as unchanged', async () => {
  const { repository, stored } = await seedRepository();
  await buildService(repository, 'v2').syncMessages({
    accountId,
    from,
    to,
    messages: [{
      messageKey: stored.message_key,
      messageId: stored.message_id,
      provider: stored.provider,
      folder: stored.folder,
      receivedAt: stored.received_at,
      sender: stored.sender,
      subject: stored.subject,
      text: archivedText,
    }],
  });

  // 下一次真同步：IMAP 送来的还是同一封正文。
  // 指纹没被重放改写 → 命中 skip，不会被复制成 |imap| 新记录。
  const live = await buildService(repository, 'v2').syncMessages({
    accountId,
    from,
    to,
    messages: [imapMessage],
  });

  assert.equal(live.skipped, 1);
  assert.equal(live.analyzed, 0);
  assert.equal(live.inserted, 0);
  const all = repository.listAnalyses({ accountId, jobRelatedOnly: false });
  assert.equal(all.length, 1, '同一封邮件不能出现两条记录');
  assert.equal(repository.listThreads({ accountId }).length, 1);
});

test('replay does not fall into the Message-ID collision branch', async () => {
  const { repository, stored } = await seedRepository();
  // 存档正文与库内指纹不同：若重放走真实 IMAP 路径，这会被判为内容冲突并
  // 退到 |imap| 身份，从而产生第二条记录。
  await buildService(repository, 'v2').syncMessages({
    accountId,
    from,
    to,
    messages: [{
      messageKey: stored.message_key,
      messageId: stored.message_id,
      provider: stored.provider,
      folder: stored.folder,
      receivedAt: stored.received_at,
      sender: stored.sender,
      subject: stored.subject,
      text: archivedText,
    }],
  });

  const rows = repository.listAnalyses({ accountId, jobRelatedOnly: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageKey, stored.message_key);
  assert.equal(rows[0].messageKey.includes('|imap|'), false);
});

test('a normal IMAP sync still detects genuinely reused Message-IDs', async () => {
  // 反向守卫：上面的 replay 豁免不能顺手把真实冲突也放过去。
  const { repository, stored } = await seedRepository();
  const different = { ...imapMessage, uid: '1002', text: '完全不同的一封通知内容。' };
  const summary = await buildService(repository, 'v2').syncMessages({
    accountId,
    from,
    to,
    messages: [different],
  });

  assert.equal(summary.inserted, 1);
  const rows = repository.listAnalyses({ accountId, jobRelatedOnly: false });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.messageKey.includes('|imap|')), '真实冲突必须退到 IMAP 身份');
  assert.ok(rows.some((row) => row.messageKey === stored.message_key), '原记录必须保留');
});
