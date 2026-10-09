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

test('thread routing signals expose the latest sender only to internal callers', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });

  const publicThread = repository.listThreads({ accountId: message.accountId })[0];
  const routingThread = repository.listThreads({ accountId: message.accountId, routingSignals: true })[0];
  assert.equal('latestSender' in publicThread, false);
  assert.equal(routingThread.latestSender, message.sender);
});

test('reanalysis moves a message to its corrected thread without leaving an orphan route', async () => {
  const { repository, service } = createFixture();
  const receipt = {
    ...message,
    uid: 'relinked-message',
    messageId: '<relinked-message@example.test>',
    subject: '感谢您的投递',
    text: '我们已经收到您的申请。',
  };
  const analysis = (company) => ({
    isJobRelated: true,
    company,
    position: '',
    status: '已投递',
    confidence: 0.8,
    evidence: '已经收到您的申请',
    nextAction: '等待后续通知',
    needsReview: true,
  });
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [receipt],
    classifierOverride: async () => analysis('旧公司'),
  });
  const reanalysisService = createSyncService({
    repository,
    classifier: fakeClassifier,
    triage: triageRecruitmentMessage,
    analysisVersion: 'phase-1-demo-v2',
  });
  await reanalysisService.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [receipt],
    classifierOverride: async () => analysis('新公司'),
  });

  const threads = repository.listThreads({ accountId: message.accountId });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].company, '新公司');
  assert.equal(repository.listThreadMessages(threads[0].id).length, 1);
});

test('reanalysis removes a stale application route when the message is corrected to non-job', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({ accountId: message.accountId, from, to, messages: [message] });
  assert.equal(repository.listThreads({ accountId: message.accountId }).length, 1);

  const reanalysisService = createSyncService({
    repository,
    classifier: fakeClassifier,
    triage: triageRecruitmentMessage,
    analysisVersion: 'phase-1-demo-v2',
  });
  await reanalysisService.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [message],
    classifierOverride: async () => ({
      isJobRelated: false,
      company: '示例科技',
      position: '',
      status: '已结束',
      confidence: 0.95,
      evidence: '这是招聘活动通知',
      nextAction: '不写入招聘进度列表',
      needsReview: false,
    }),
  });

  assert.equal(repository.listThreads({ accountId: message.accountId }).length, 0);
  assert.equal(repository.listAnalyses({ accountId: message.accountId, jobRelatedOnly: false })[0].isJobRelated, false);
});

test('reanalysis keeps a user-corrected application position while the archived mail stays unrecognized', async () => {
  const { repository, service } = createFixture();
  const receipt = {
    ...message,
    uid: 'manual-position-override',
    messageId: '<manual-position-override@example.test>',
    subject: '示例互联校园招聘投递成功通知',
    text: '我们已经收到你的简历并会认真评估。',
  };
  const unknownAnalysis = {
    isJobRelated: true,
    company: '示例互联',
    position: '',
    status: '已投递',
    confidence: 0.72,
    evidence: '已经收到你的简历',
    nextAction: '等待后续通知',
    needsReview: true,
    threadRef: 'new',
  };
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [receipt],
    classifierOverride: async () => unknownAnalysis,
  });
  const initialThread = repository.listThreads({ accountId: message.accountId })[0];
  repository.updateThread(initialThread.id, {
    position: '用户产品经理',
    manualPositionOverride: true,
    needsReview: false,
  });

  const reanalysisService = createSyncService({
    repository,
    classifier: fakeClassifier,
    triage: triageRecruitmentMessage,
    analysisVersion: 'phase-1-demo-v2',
  });
  await reanalysisService.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [receipt],
    classifierOverride: async () => unknownAnalysis,
  });

  const threads = repository.listThreads({ accountId: message.accountId });
  const archived = repository.listAnalyses({ accountId: message.accountId });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].position, '用户产品经理');
  assert.equal(threads[0].manualPositionOverride, true);
  assert.equal(repository.listThreadMessages(threads[0].id).length, 1);
  assert.equal(archived[0].position, '');
  assert.equal(archived[0].needsReview, true);
});

test('two positionless receipts from one company share a thread and preserve both original mails', async () => {
  const { repository, service } = createFixture();
  const receipts = [
    {
      ...message,
      uid: 'new-route-1',
      messageId: '<new-route-1@example.test>',
      receivedAt: '2026-08-21T08:30:00.000Z',
      sender: 'noreply@mail.vendor.test',
      subject: '示例科技投递成功通知',
      text: '我们已经收到你的简历并会认真评估。',
    },
    {
      ...message,
      uid: 'new-route-2',
      messageId: '<new-route-2@example.test>',
      receivedAt: '2026-08-22T08:30:00.000Z',
      sender: 'noreply@mail.vendor.test',
      subject: '示例科技投递成功通知',
      text: '我们已经收到你的简历并会认真评估。',
    },
  ];
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: receipts,
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例科技',
      position: '',
      status: '已投递',
      confidence: 0.72,
      evidence: '已经收到你的简历',
      nextAction: '等待后续通知',
      needsReview: true,
      threadRef: 'new',
    }),
  });

  const threads = repository.listThreads({ accountId: message.accountId });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].position, '');
  assert.equal(threads[0].needsReview, true);
  assert.equal(repository.listThreadMessages(threads[0].id).length, 2);
});

test('syncMessages ignores a message outside the selected date range', async () => {
  const { service } = createFixture();
  const result = await service.syncMessages({
    accountId: message.accountId,
    from,
    to: '2026-08-20T23:59:59.999Z',
    messages: [message],
  });

  assert.deepEqual(result, { inserted: 0, analyzed: 0, skipped: 0, ignored: 0, candidates: 0, results: [], modelFailed: 0, failures: [], processed: 0, total: 0, remaining: 0, stopReason: null, retryFrom: null });
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
    messages: [{ ...message, uid: 'assessment-1', receivedAt: '2026-08-09T15:45:00.000Z', subject: '在线测评通知', text: '请完成在线测评。' }],
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
    messages: [{ ...message, uid: 'assessment-2', receivedAt: '2026-08-09T15:45:00.000Z', subject: '在线测评通知', text: '请完成在线测评。' }],
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

test('explicit assessment evidence overrides model date drift', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T23:59:59.999Z',
    messages: [{
      ...message,
      uid: 'assessment-explicit',
      receivedAt: '2026-09-10T08:38:59.000Z',
      subject: '示例商城集团邀请你参加在线笔试',
      text: '考试时间：(北京时间,UTC+08:00)2026-09-12 10:00:00 -- 11:40:00',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例商城集团',
      position: '',
      status: '测评中',
      confidence: 0.9,
      evidence: '在线笔试',
      nextAction: '完成笔试',
      needsReview: true,
      eventStart: '2025-09-12T02:00:00.000Z',
      eventEnd: '2025-09-12T03:40:00.000Z',
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.eventStart, '2026-09-12T02:00:00.000Z');
  assert.equal(row.eventEnd, '2026-09-12T03:40:00.000Z');
});

test('sync does not replace an empty model position with a company mail-template extraction', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T23:59:59.999Z',
    messages: [{
      ...message,
      uid: 'repaired-warnings',
      receivedAt: '2026-09-11T02:42:23.000Z',
      subject: '【示例旅行集团】请在邮件规定时间内完成能力测评',
      text: '感谢投递示例旅行集团校园招聘AI 产品经理（2027届秋招）职位，请在3个工作日内完成测评。',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例旅行集团',
      position: '',
      status: '测评中',
      confidence: 0.95,
      evidence: '请在3个工作日内完成测评',
      nextAction: '完成测评',
      needsReview: true,
      notes: '时间未在邮件中明确出现，已忽略。 position 为流程词/邮件主题词，已置空待人工确认。',
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.position, '');
  assert.equal(row.needsReview, true);
  assert.equal(row.notes, '测评截止时间：2026-09-16 10:42');
});

test('submitted progress discards model notes and does not fall back to evidence', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: 'submitted-clean-notes',
      subject: '示例邮件科技校园招聘申请确认',
      text: '感谢投递产品经理岗位，我们已经收到您的简历。',
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例邮件科技',
      position: '产品经理',
      status: '已投递',
      confidence: 0.95,
      evidence: '感谢投递产品经理岗位，我们已经收到您的简历。',
      nextAction: '等待后续通知',
      needsReview: false,
      notes: '岗位未识别；部分邮件原文',
    }),
  });

  const messageRow = repository.listAnalyses()[0];
  const threadRow = repository.listThreads({ accountId: message.accountId })[0];
  assert.equal(messageRow.notes, '');
  assert.equal(threadRow.notes, '');
});

test('strong receipt evidence can correct job relevance without inventing company aliases or a position', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: 'example-audio-1',
      messageId: '<example-audio-1@example.test>',
      receivedAt: '2026-08-28T18:19:14.000Z',
      subject: '示例声学科技投递反馈',
      text: '我们已收到您对27届正式批-产品GTM培训生的申请，并会尽快查看您的简历。',
    }],
    classifierOverride: async () => ({
      isJobRelated: false,
      company: '示例声学科技',
      position: '',
      status: '已结束',
      confidence: 0.8,
      evidence: '模型误判为宣传邮件',
      nextAction: '不写入招聘进度列表',
      needsReview: false,
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.company, '示例声学科技');
  assert.equal(row.position, '');
  assert.equal(row.status, '已投递');
});

test('an explicit assessment with an actionable link corrects a false-negative model result', async () => {
  const { repository, service } = createFixture();
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: 'assessment-false-negative',
      messageId: '<assessment-false-negative@example.test>',
      receivedAt: '2026-08-28T15:18:27.000Z',
      sender: 'EXAMPLE_HARDWARE <example-hardware-noreply-hire@mail.vendor.test>',
      subject: '【示例硬件校招测评】2027届校园招聘',
      text: '测评链接：https://assessment.example.test/e-entrance/example-code',
    }],
    classifierOverride: async () => ({
      isJobRelated: false,
      company: '示例硬件',
      position: '',
      status: '测评中',
      confidence: 0.52,
      evidence: '校招测评',
      nextAction: '完成测评',
      needsReview: true,
    }),
  });

  const archived = repository.listAnalyses({ accountId: message.accountId });
  const threads = repository.listThreads({ accountId: message.accountId });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].isJobRelated, true);
  assert.equal(archived[0].status, '测评中');
  assert.match(archived[0].notes, /https:\/\/assessment\.example\.test\/e-entrance\/example-code/);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].company, '示例硬件');
  assert.equal(threads[0].position, '');
});

test('assessment evidence overrides a noisy status and keeps the full actionable link', async () => {
  const { repository, service } = createFixture();
  const actionUrl = `https://assessment.example.test/start?token=${'z'.repeat(260)}`;
  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: [{
      ...message,
      uid: 'example-hardware-1',
      messageId: '<example-hardware-1@example.test>',
      receivedAt: '2026-08-28T15:18:27.000Z',
      subject: '【示例硬件校招测评】2027届校园招聘',
      text: '请点击链接完成测评。',
      html: `<p>测评链接：<a href="${actionUrl}">开始测评</a></p>`,
    }],
    classifierOverride: async () => ({
      isJobRelated: true,
      company: '示例硬件',
      position: '',
      status: '已结束',
      confidence: 0.6,
      evidence: '邮件含多个链接',
      nextAction: '等待',
      needsReview: true,
    }),
  });

  const row = repository.listAnalyses()[0];
  assert.equal(row.status, '测评中');
  assert.equal(row.eventStart, '2026-08-28T15:18:27.000Z');
  assert.equal(row.notes, `测评链接：${actionUrl}`);
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

test('distinct IMAP messages that reuse Message-ID remain separate archived mails and routes', async () => {
  const { repository, service } = createFixture();
  const springMessages = [
    {
      ...message,
      uid: 'spring-1',
      messageId: '<reused-by-ats@example.test>',
      receivedAt: '2026-08-22T02:03:08.000Z',
      subject: '示例出行-应聘状态变更通知',
      text: '感谢您应聘示例业务培训生-航线，您的简历已进入人才库。',
    },
    {
      ...message,
      uid: 'spring-2',
      messageId: '<reused-by-ats@example.test>',
      receivedAt: '2026-08-22T02:05:07.000Z',
      subject: '示例出行-应聘状态变更通知',
      text: '感谢您应聘示例业务培训生-产品（2027届），您的简历已进入人才库。',
    },
  ];

  await service.syncMessages({
    accountId: message.accountId,
    from,
    to,
    messages: springMessages,
    classifierOverride: async ({ text }) => ({
      isJobRelated: true,
      company: '示例出行',
      position: text.includes('航线') ? '示例业务培训生-航线' : '示例业务培训生-产品（2027届）',
      status: '已结束',
      confidence: 0.95,
      evidence: '简历已进入人才库',
      nextAction: '无需操作',
      needsReview: false,
    }),
  });

  const archived = repository.listAnalyses({ jobRelatedOnly: false });
  const threads = repository.listThreads({});
  assert.equal(archived.length, 2);
  assert.equal(threads.length, 2);
  assert.notEqual(threads[0].latestMessageId, threads[1].latestMessageId);
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

test('syncMessages never exposes another mailbox account threads to the classifier', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  repository.upsertThreadFromMessage({
    accountId: 'other@example.test',
    company: '其他公司',
    position: '其他岗位',
    status: '已投递',
    confidence: 1,
    needsReview: false,
    evidence: '其他账号邮件',
    nextAction: '等待',
    receivedAt: '2026-08-01T00:00:00.000Z',
    messageId: null,
  });
  let seenOpenThreads;
  const service = createSyncService({ repository, analysisVersion: 'account-scope-v1' });
  await service.syncMessages({
    accountId: 'current@example.test',
    from,
    to,
    messages: [{ ...message, accountId: 'current@example.test' }],
    classifierOverride: async (input) => {
      seenOpenThreads = input.openThreads.map((thread) => ({ ...thread }));
      return fakeClassifier();
    },
  });
  assert.deepEqual(seenOpenThreads, []);
});

test('the confirmed JD sequence merges into one unknown-position application route', async () => {
  const { repository, service } = createFixture();
  const jdMessages = [
    {
      ...message,
      uid: 'mall-1', messageId: '<mall-1@example.test>', receivedAt: '2026-09-04T11:29:30.000Z',
      subject: '【示例商城校招】我们已收到你的申请，请及时关注后续进展',
      text: '我们已收到您的申请，请关注后续进展。',
    },
    {
      ...message,
      uid: 'mall-2', messageId: '<mall-2@example.test>', receivedAt: '2026-09-09T01:52:13.000Z',
      subject: '【示例商城校招】2027 综合测评通知',
      text: '邀请您完成在线测评。',
    },
    {
      ...message,
      uid: 'mall-3', messageId: '<mall-3@example.test>', receivedAt: '2026-09-10T08:38:59.000Z',
      subject: '示例商城集团邀请你参加在线笔试',
      text: '您投递的意向岗位涉及笔试时需要完成考试。试卷名称：示例商城集团2027校招-产品经理试卷-0912。',
    },
  ];
  let call = 0;
  await service.syncMessages({
    accountId: message.accountId,
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T23:59:59.999Z',
    messages: jdMessages,
    classifierOverride: async () => {
      call += 1;
      return {
        isJobRelated: true,
        company: call === 3 ? '示例商城集团' : '示例商城',
        position: '',
        status: call === 1 ? '已投递' : '测评中',
        confidence: 0.8,
        evidence: '示例商城招聘流程通知',
        nextAction: call === 1 ? '等待' : '完成测评',
        needsReview: true,
      };
    },
  });

  const threads = repository.listThreads({ accountId: message.accountId });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].company, '示例商城');
  assert.equal(threads[0].position, '');
  assert.equal(threads[0].status, '测评中');
  assert.equal(threads[0].latestReceivedAt, '2026-09-10T08:38:59.000Z');
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

test('a message whose classifier fails three times is dropped and counted, not saved', async () => {
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
  assert.equal(calls, 3);
  // 逐字段断言而不是 deepEqual 整个对象：failure 记录会随诊断需要加字段
  // （2026-09-27 就补了 message），深比较会让无关的字段变更炸掉这个测试。
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].receivedAt, '2026-05-01T00:00:00Z');
  assert.equal(summary.failures[0].subject, '感谢您的投递');
  assert.equal(summary.failures[0].error, 'Error');
  assert.equal(summary.failures[0].message, 'boom');
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

test('a provider rate limit stops retrying the same message immediately', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const rateLimited = async () => {
    calls += 1;
    const error = new Error('model request failed with status 429');
    error.code = 'MODEL_RATE_LIMITED';
    error.status = 429;
    throw error;
  };
  const service = createSyncService({
    repository,
    classifier: rateLimited,
    triage: triageRecruitmentMessage,
    analysisVersion: 't',
    concurrency: 1,
  });
  const summary = await service.syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages: [
      { messageId: '<limit@test>', receivedAt: '2026-05-01T00:00:00Z', sender: 's', subject: '投递确认', text: '已收到申请' },
      { messageId: '<later@test>', receivedAt: '2026-05-02T00:00:00Z', sender: 's', subject: '投递确认', text: '已收到另一份申请' },
    ],
  });

  // concurrency=1 时并发退化为串行：撞到限流后不再发出任何后续请求。
  assert.equal(calls, 1);
  // 阶段 A 会先把窗口内的候选全部筛出来（不发起请求），因此 candidates 仍是 2；
  // 中断发生在阶段 B 的落库环节，表现为「一封都没写进库」。
  assert.equal(summary.candidates, 2);
  assert.equal(summary.modelFailed, 1);
  assert.equal(summary.failures[0].error, 'MODEL_RATE_LIMITED');
  assert.equal(summary.analyzed, 0);
});

// 并发下「限流后一个请求都不再发」是做不到的：最多 concurrency 个请求已经在飞。
// 真正该保证的是熔断生效——待发队列被跳过，请求数不超过并发窗口。
test('a rate limit trips the circuit breaker so queued messages are never sent', async () => {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  let calls = 0;
  const rateLimited = async () => {
    calls += 1;
    const error = new Error('model request failed with status 429');
    error.code = 'MODEL_RATE_LIMITED';
    error.status = 429;
    throw error;
  };
  const service = createSyncService({
    repository,
    classifier: rateLimited,
    triage: triageRecruitmentMessage,
    analysisVersion: 't',
    concurrency: 3,
  });
  const messages = Array.from({ length: 12 }, (_, i) => ({
    messageId: `<rl-${i}@test>`,
    receivedAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    sender: 's',
    subject: '投递确认',
    text: '已收到申请',
  }));
  const summary = await service.syncMessages({
    accountId: 'a',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    messages,
  });

  assert.ok(calls <= 3, `熔断后请求数应不超过并发窗口 3，实际 ${calls}`);
  assert.ok(calls < messages.length, `熔断应跳过大部队列，实际发了 ${calls}/${messages.length}`);
  assert.equal(summary.analyzed, 0, '限流时不应写入任何分析结果');
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
    messages: [{ messageId: `<m-${receivedAt}>`, receivedAt, sender: 's', subject: '面试反馈问卷', text: '感谢你参加示例计算招聘，请填写面试反馈问卷' }],
  });

  await sync({ isJobRelated: true, company: '示例计算', position: '产品运营实习生', status: '已结束', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, '2026-04-21T08:00:00.000Z');
  const ended = repository.listThreads({});
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, '已结束');

  // 晚到的面试邀请：不得把该线程改回面试，也不得丢邮件
  await sync({ isJobRelated: true, company: '示例计算', position: '产品运营实习生', status: '面试', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false, threadRef: ended[0].id }, '2026-04-25T00:00:00.000Z');
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

  await sync({ isJobRelated: true, company: '示例网络', position: '产品培训生', status: '已结束', confidence: .9, evidence: 'e', nextAction: 'n', needsReview: false }, '2026-05-01T00:00:00.000Z');
  await sync({ isJobRelated: true, company: '示例网络', position: '产品培训生', status: '已结束', confidence: .9, evidence: 'e2', nextAction: 'n', needsReview: false }, '2026-05-09T00:00:00.000Z');

  const threads = repository.listThreads({});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, '已结束');
  assert.equal(threads[0].latestReceivedAt, '2026-05-09T00:00:00.000Z');
  assert.equal(threads[0].evidence, 'e2');
});
