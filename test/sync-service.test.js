import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createSyncService } from '../src/services/sync-service.js';
import { triageRecruitmentMessage } from '../src/domain/triage.js';

let database;

afterEach(() => {
  database?.close();
  database = undefined;
});

// 模拟 LLM 的确定性分析结果（不回退原则下，classifier 必须显式注入）
const fakeClassifier = async () => ({
  isJobRelated: true,
  company: '示例科技',
  position: '后端开发工程师',
  status: '面试',
  confidence: 0.9,
  evidence: '邀请你参加技术面试',
  nextAction: '确认面试时间',
  needsReview: false,
});

function createFixture() {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const service = createSyncService({
    repository,
    classifier: fakeClassifier,
    triage: triageRecruitmentMessage,
    analysisVersion: 'phase-1-demo-v1',
  });
  return { repository, service };
}

const from = '2026-08-01T00:00:00.000Z';
const to = '2026-08-31T23:59:59.999Z';
const message = {
  accountId: 'demo@qq.com',
  provider: 'qq',
  folder: 'INBOX',
  uidValidity: 'demo-1',
  uid: '1001',
  messageId: '<demo-1001@example.test>',
  receivedAt: '2026-08-21T08:30:00.000Z',
  sender: '招聘团队 <recruit@example.test>',
  subject: '示例科技技术面试邀请',
  text: '公司：示例科技\n职位：后端开发工程师\n我们邀请你参加技术面试，请确认时间。',
};

test('syncMessages analyzes an in-range message once and skips the unchanged copy', async () => {
  const { service } = createFixture();
  const first = await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });
  const second = await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });

  assert.equal(first.inserted, 1);
  assert.equal(first.analyzed, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.results[0].status, '面试');
  assert.equal(second.inserted, 0);
  assert.equal(second.analyzed, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.results.length, 0);
});

test('syncMessages ignores a message outside the selected date range', async () => {
  const { service } = createFixture();
  const result = await service.syncMessages({
    accountId: message.accountId,
    from,
    to: '2026-08-20T23:59:59.999Z',
    messages: [message],
  });

  assert.deepEqual(result, { inserted: 0, analyzed: 0, skipped: 0, ignored: 0, candidates: 0, results: [], modelFailed: 0 });
});

test('syncMessages never calls the model for recruitment announcements', async () => {
  let classifierCalls = 0;
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const service = createSyncService({
    repository,
    triage: triageRecruitmentMessage,
    classifier: async () => { classifierCalls += 1; throw new Error('model must not be called'); },
    analysisVersion: 'phase-2-backend-v1',
  });

  const result = await service.syncMessages({
    accountId: 'demo@qq.com',
    from,
    to,
    messages: [{
      ...message,
      subject: '招聘活动预告',
      text: '欢迎参加校园招聘活动和宣讲会。',
    }],
  });

  assert.equal(classifierCalls, 0);
  assert.equal(result.ignored, 1);
  assert.equal(result.analyzed, 0);
  assert.equal(repository.listAnalyses().length, 0);
});

test('syncMessages dry run returns triage counts without writing SQLite', async () => {
  const { repository, service } = createFixture();
  const result = await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    dryRun: true,
    messages: [message],
  });

  assert.equal(result.candidates, 1);
  assert.equal(result.analyzed, 0);
  assert.equal(repository.listAnalyses().length, 0);
  assert.equal(repository.listSyncRuns().length, 0);
});

test('syncMessages derives an assessment start from receipt time when only a deadline is available', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{ ...message, uid: 'assessment-1', receivedAt: '2026-08-09T15:45:00.000Z' }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '后端开发工程师',
      status: '测评中',
      confidence: 0.9,
      evidence: '邮件给出了测评截止时间。',
      nextAction: '完成测评',
      needsReview: false,
      eventEnd: '2026-08-12T23:59:00.000Z',
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.eventStart, '2026-08-09T15:45:00.000Z');
  assert.equal(row.eventEnd, '2026-08-12T23:59:00.000Z');
});

test('syncMessages always anchors an assessment deadline window at the receipt time', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{ ...message, uid: 'assessment-2', receivedAt: '2026-08-09T15:45:00.000Z' }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '后端开发工程师',
      status: '测评中',
      confidence: 0.9,
      evidence: '邮件给出了测评截止时间。',
      nextAction: '完成测评',
      needsReview: false,
      eventStart: '2025-06-03T16:00:00.000Z',
      eventEnd: '2026-08-12T23:59:00.000Z',
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.eventStart, '2026-08-09T15:45:00.000Z');
  assert.equal(row.eventEnd, '2026-08-12T23:59:00.000Z');
});

test('syncMessages aggregates same-company same-position messages into one application thread', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: '1002',
      messageId: '<demo-1002@example.test>',
      receivedAt: '2026-08-22T08:30:00.000Z',
      subject: '示例科技测评通知',
      text: '公司：示例科技\n职位：后端开发工程师\n请在截止时间前完成在线测评。',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '后端开发工程师',
      status: '测评中',
      confidence: 0.9,
      evidence: '请完成在线测评。',
      nextAction: '完成测评',
      needsReview: false,
    }),
  });

  const threads = repository.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].company, '示例科技');
  assert.equal(threads[0].position, '后端开发工程师');
  assert.equal(threads[0].status, '测评中');
  assert.equal(threads[0].latestReceivedAt, '2026-08-22T08:30:00.000Z');
  const analyzed = repository.listAnalyses({});
  assert.equal(threads[0].latestMessageId, analyzed.find((row) => row.status === '测评中').id);
});

test('syncMessages passes the open thread list to the classifier', async () => {
  const { service } = createFixture();
  await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });
  let seenOpenThreads;
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{ ...message, uid: '1003', messageId: '<demo-1003@example.test>', receivedAt: '2026-08-23T08:30:00.000Z' }],
    classifierOverride: async (input) => {
      seenOpenThreads = input.openThreads;
      return { isJobRelated: true, company: '示例科技', position: '后端开发工程师', status: '面试', confidence: 0.9, evidence: '邀请面试', nextAction: '确认时间', needsReview: false };
    },
  });

  assert.equal(Array.isArray(seenOpenThreads), true);
  assert.equal(seenOpenThreads.length, 1);
  assert.equal(seenOpenThreads[0].company, '示例科技');
  assert.equal(seenOpenThreads[0].status, '面试');
});

test('syncMessages does not create a thread for non-job-related messages', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [message],
    classifierOverride: async () => ({
      isJobRelated: false,
      company: '',
      position: '',
      status: '已结束',
      confidence: 0.9,
      evidence: '岗位推荐广告',
      nextAction: '不写入招聘进度列表',
      needsReview: false,
    }),
  });

  assert.equal(repository.listThreads({}).length, 0);
  assert.equal(repository.listAnalyses({ jobRelatedOnly: false }).length, 1);
});

test('syncMessages fans an assessment out to sibling threads via appliesTo', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: '1005',
      messageId: '<demo-1005@example.test>',
      receivedAt: '2026-08-22T08:30:00.000Z',
      subject: '示例科技投递确认',
      text: '公司：示例科技\n职位：前端开发工程师\n我们已收到你的申请。',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '前端开发工程师',
      status: '已投递',
      confidence: 0.9,
      evidence: '已收到你的申请。',
      nextAction: '等待进展',
      needsReview: false,
    }),
  });
  const threadsAfterSetup = repository.listThreads({});
  const frontendThreadId = threadsAfterSetup.find((thread) => thread.position === '前端开发工程师').id;
  const backendThreadId = threadsAfterSetup.find((thread) => thread.position === '后端开发工程师').id;
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: '1004',
      messageId: '<demo-1004@example.test>',
      receivedAt: '2026-08-23T08:30:00.000Z',
      subject: '示例科技测评通知',
      text: '公司：示例科技\n职位：前端开发工程师\n请完成在线测评，结果适用于你投递的全部岗位。',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '前端开发工程师',
      status: '测评中',
      confidence: 0.9,
      evidence: '请完成在线测评。',
      nextAction: '完成测评',
      needsReview: false,
      appliesTo: [frontendThreadId, backendThreadId, 9999],
    }),
  });

  const threads = repository.listThreads({});
  assert.equal(threads.length, 2);
  for (const thread of threads) {
    assert.equal(thread.status, '测评中');
    assert.equal(thread.latestReceivedAt, '2026-08-23T08:30:00.000Z');
  }
});

test('a message whose classifier fails twice is dropped and counted, not saved', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const service = createSyncService({
    repository,
    classifier: async () => { calls += 1; throw new Error('boom'); },
    triage: triageRecruitmentMessage,
    analysisVersion: 't',
  });
  const summary = await service.syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages: [{ messageId: '<x@y>', receivedAt: '2026-05-01T00:00:00Z', sender: 's', subject: '感谢您的投递', text: '已收到申请' }],
  });
  assert.equal(summary.modelFailed, 1);
  assert.equal(summary.analyzed, 0);
  assert.equal(repository.listAnalyses({}).length, 0);
});

test('a transient failure retries once and succeeds on second call', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('502'); return { isJobRelated: true, company: '甲', position: '后端', status: '已投递', confidence: .9, evidence: '收到申请', nextAction: '等待', needsReview: false }; };
  const service = createSyncService({
    repository,
    classifier: flaky,
    triage: triageRecruitmentMessage,
    analysisVersion: 't',
  });
  const summary = await service.syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages: [{ messageId: '<r@r>', receivedAt: '2026-05-01T00:00:00Z', sender: 's', subject: '投递确认', text: '已收到' }],
  });
  assert.equal(calls, 2);
  assert.equal(summary.analyzed, 1);
  assert.equal(summary.modelFailed, 0);
});

test('a non-terminal email cannot resurrect an ended thread, and is kept as a review row', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const stub = (analysis) => ({ classify: async () => analysis });
  const sync = (analysis, receivedAt) => createSyncService({
    repository,
    classifier: stub(analysis),
    analysisVersion: 't',
  }).syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages: [{ messageId: `<m-${receivedAt}>`, receivedAt, sender: 's', subject: '面试反馈问卷', text: '感谢你参加联想招聘，请填写面试反馈问卷' }],
  });

  await sync({ isJobRelated: true, company: '联想', position: '产品运营实习生', status: '已结束', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, '2026-04-21T08:00:00.000Z');
  const ended = repository.listThreads({});
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, '已结束');

  // 晚到的面试邀请：不得把该线程改回面试，也不得丢邮件
  await sync({ isJobRelated: true, company: '联想', position: '产品运营实习生', status: '面试', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false, threadRef: ended[0].id }, '2026-04-25T00:00:00.000Z');
  const after = repository.listThreads({});
  assert.equal(after.find((thread) => thread.id === ended[0].id).status, '已结束');
  assert.equal(after.length, 2);
  assert.equal(after.filter((thread) => thread.status === '面试').length, 1);
});

test('a second terminal notification still lands on the same ended thread', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const stub = (analysis) => ({ classify: async () => analysis });
  const sync = (analysis, receivedAt) => createSyncService({
    repository,
    classifier: stub(analysis),
    analysisVersion: 't',
  }).syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages: [{ messageId: `<m-${receivedAt}>`, receivedAt, sender: 's', subject: '流程已结束通知', text: '本次流程已结束，感谢关注' }],
  });

  await sync({ isJobRelated: true, company: '腾讯', position: '产品培训生', status: '已结束', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, '2026-05-01T00:00:00.000Z');
  await sync({ isJobRelated: true, company: '腾讯', position: '产品培训生', status: '已结束', confidence: .9, evidence: 'e2', nextAction: 'n', needsReview: false }, '2026-05-09T00:00:00.000Z');

  const threads = repository.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, '已结束');
  assert.equal(threads[0].latestReceivedAt, '2026-05-09T00:00:00.000Z');
  assert.equal(threads[0].evidence, 'e2');
});
