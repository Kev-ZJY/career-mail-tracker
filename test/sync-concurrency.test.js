import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createSyncService } from '../src/services/sync-service.js';
import { triageRecruitmentMessage } from '../src/domain/triage.js';

let databases = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases = [];
});

function buildDatabase() {
  const database = createDatabase(':memory:');
  databases.push(database);
  return database;
}

const from = '2026-01-01T00:00:00.000Z';
const to = '2026-12-31T23:59:59.999Z';

// 一批能触发真实归并分支的邮件：同公司多岗位、跨公司、状态流转、无岗位、
// 结束态、以及复用 Message-ID 的两封。覆盖得越全，并发与串行的差异越容易暴露。
function buildMessages() {
  return [
    { uid: '1', messageId: '<a1@t>', receivedAt: '2026-03-01T01:00:00Z', sender: '示例网络招聘 <hr@exampleNetwork.test>', subject: '示例网络投递成功通知', text: '我们已收到你的申请，感谢投递。' },
    { uid: '2', messageId: '<a2@t>', receivedAt: '2026-03-05T02:00:00Z', sender: '示例网络招聘 <hr@exampleNetwork.test>', subject: '示例网络测评通知', text: '邀请你完成在线测评，请点击 http://t.test/eval 开始。' },
    { uid: '3', messageId: '<a3@t>', receivedAt: '2026-03-09T03:00:00Z', sender: '示例网络招聘 <hr@exampleNetwork.test>', subject: '示例网络面试邀请', text: '邀请你参加技术面试，请确认时间。' },
    { uid: '4', messageId: '<a4@x>', receivedAt: '2026-04-02T04:00:00Z', sender: '示例互联招聘 <hr@example-internet.test>', subject: '示例互联投递成功', text: '已收到你的申请。' },
    { uid: '5', messageId: '<a5@x>', receivedAt: '2026-04-06T05:00:00Z', sender: '示例互联招聘 <hr@example-internet.test>', subject: '示例互联结果通知', text: '很遗憾，你没有通过本次筛选。' },
    { uid: '6', messageId: '<a6@y>', receivedAt: '2026-05-11T06:00:00Z', sender: '招聘助手 <noreply@helper.test>', subject: '面试反馈问卷', text: '感谢你参加面试，请填写问卷。' },
    { uid: '7', messageId: '<a7@z>', receivedAt: '2026-06-01T07:00:00Z', sender: '某公司 <hr@unknown.test>', subject: '感谢您投递', text: '我们已收到您的申请。' },
    { uid: '8', messageId: '<reused@t>', receivedAt: '2026-06-05T08:00:00Z', sender: '示例出行 <hr@example-travel.test>', subject: '示例出行应聘状态变更', text: '感谢您应聘示例业务培训生-航线。' },
    { uid: '9', messageId: '<reused@t>', receivedAt: '2026-06-05T08:05:00Z', sender: '示例出行 <hr@example-travel.test>', subject: '示例出行应聘状态变更', text: '感谢您应聘示例业务培训生-产品（2027届）。' },
    { uid: '10', messageId: '<a10@t>', receivedAt: '2026-07-01T09:00:00Z', sender: '示例网络招聘 <hr@exampleNetwork.test>', subject: '示例网络 offer', text: '恭喜你获得录用通知，请确认入职安排。' },
  ].map((m) => ({ ...m, folder: 'INBOX', uidValidity: 'v1' }));
}

// 确定性「模型」：按正文里的关键词返回固定结果，不含随机与时间因素。
// 返回结构对齐真实 classifier 的输出契约。判定顺序即优先级，
// 特别地：offer/面试/测评 的判定必须排在「已收到申请」之前，
// 否则投递确认会抢先把每一封都归到「已投递」，状态流转就串不起来，
// 线程也就无法暴露「顺序错了」这类缺陷。
function fakeClassifier({ text, subject }) {
  if (/录用|offer/i.test(text)) {
    return { isJobRelated: true, company: '示例网络', position: '产品经理', status: 'Offer', confidence: .95, evidence: '录用通知', nextAction: '确认录用安排', needsReview: false };
  }
  if (/没有通过/.test(text)) {
    return { isJobRelated: true, company: '示例互联', position: '产品经理', status: '已结束', confidence: .9, evidence: '未通过筛选', nextAction: '归档该申请', needsReview: false };
  }
  if (/测评/.test(text)) {
    return { isJobRelated: true, company: '示例网络', position: '产品经理', status: '测评中', confidence: .9, evidence: '邀请完成测评', nextAction: '完成测评', needsReview: false };
  }
  if (/面试/.test(text)) {
    return { isJobRelated: true, company: '示例网络', position: '产品经理', status: '面试', confidence: .9, evidence: '邀请参加面试', nextAction: '准备并参加面试', needsReview: false };
  }
  if (/问卷/.test(subject)) {
    return { isJobRelated: false, company: '', position: '', status: '已结束', confidence: .8, evidence: '面试反馈问卷', nextAction: '不写入招聘进度列表', needsReview: false };
  }
  if (/示例出行/.test(subject)) {
    const position = /航线/.test(text) ? '示例业务培训生-航线' : '示例业务培训生-产品（2027届）';
    return { isJobRelated: true, company: '示例出行', position, status: '已投递', confidence: .9, evidence: '简历已进入人才库', nextAction: '等待后续通知', needsReview: false };
  }
  if (/示例互联/.test(subject)) {
    return { isJobRelated: true, company: '示例互联', position: '产品经理', status: '已投递', confidence: .9, evidence: '已收到申请', nextAction: '等待后续通知', needsReview: false };
  }
  if (/示例网络/.test(subject)) {
    return { isJobRelated: true, company: '示例网络', position: '产品经理', status: '已投递', confidence: .9, evidence: '已收到申请', nextAction: '等待后续通知', needsReview: false };
  }
  return { isJobRelated: true, company: '', position: '', status: '已投递', confidence: .6, evidence: '已收到申请', nextAction: '等待后续通知', needsReview: false };
}

async function runWith(concurrency) {
  const database = buildDatabase();
  const repository = createMessageRepository(database.db);
  const service = createSyncService({
    repository,
    classifier: fakeClassifier,
    analysisVersion: 'concurrency-test-v1',
    triage: triageRecruitmentMessage,
    concurrency,
  });
  const summary = await service.syncMessages({
    accountId: 'a@test',
    from,
    to,
    messages: buildMessages(),
  });
  const threads = repository.listThreads({}).map((t) => ({
    company: t.company,
    position: t.position,
    status: t.status,
    latestReceivedAt: t.latestReceivedAt,
    nextAction: t.nextAction,
    needsReview: t.needsReview,
  })).sort((a, b) => `${a.company}|${a.position}`.localeCompare(`${b.company}|${b.position}`));
  const archived = repository.listAnalyses({ jobRelatedOnly: false })
    .map((r) => ({ subject: r.subject, company: r.company, position: r.position, status: r.status }))
    .sort((a, b) => `${a.subject}|${a.company}`.localeCompare(`${b.subject}|${b.company}`));
  return { summary, threads, archived };
}

// 守卫测试本身的有效性：如果样本没串成状态流转，上面的「一致性」断言
// 可能因为两边都退化成互不相干的独立线程而恒真。先证明样本能触发归并。
test('the fixture actually merges the exampleNetwork sequence into one evolving thread', async () => {
  const run = await runWith(1);
  const exampleNetwork = run.threads.filter((t) => t.company === '示例网络');
  assert.equal(exampleNetwork.length, 1, `示例网络的四封应归并成一条线程，实际 ${exampleNetwork.length} 条：${JSON.stringify(exampleNetwork)}`);
  // 按时间顺序：投递 → 测评 → 面试 → Offer，终态应为 Offer
  assert.equal(exampleNetwork[0].status, 'Offer', `线程终态应为 Offer，实际 ${exampleNetwork[0].status}`);
  assert.equal(exampleNetwork[0].position, '产品经理');

  const exampleInternet = run.threads.filter((t) => t.company === '示例互联');
  assert.equal(exampleInternet.length, 1, '示例互联的两封应归并成一条线程');
  assert.equal(exampleInternet[0].status, '已结束', '未通过通知应把线程推进到已结束');
});

// 核心守卫：并发只允许改变耗时，不允许改变归并结果。
// 若阶段 A/B 的切分漏了 openThreads 这类状态依赖，这里必然红。
test('concurrent merging produces exactly the same threads as serial merging', async () => {
  const serial = await runWith(1);
  const parallel = await runWith(4);

  assert.deepEqual(parallel.threads, serial.threads, '并发与串行的线程归并结果必须逐字段一致');
  assert.deepEqual(parallel.archived, serial.archived, '并发与串行的邮件档案必须逐字段一致');
  assert.equal(parallel.summary.inserted, serial.summary.inserted);
  assert.equal(parallel.summary.analyzed, serial.summary.analyzed);
  assert.equal(parallel.summary.skipped, serial.summary.skipped);
  assert.equal(parallel.summary.ignored, serial.summary.ignored);
  assert.equal(parallel.summary.modelFailed, serial.summary.modelFailed);
});

test('results stay identical as concurrency scales up', async () => {
  const baseline = await runWith(1);
  for (const width of [2, 4, 8]) {
    const run = await runWith(width);
    assert.deepEqual(run.threads, baseline.threads, `并发度 ${width} 的线程结果与串行不一致`);
    assert.deepEqual(run.archived, baseline.archived, `并发度 ${width} 的邮件档案与串行不一致`);
  }
});

test('a second run over the same window analyzes nothing new', async () => {
  const database = buildDatabase();
  const repository = createMessageRepository(database.db);
  const service = createSyncService({
    repository,
    classifier: fakeClassifier,
    analysisVersion: 'concurrency-test-v1',
    triage: triageRecruitmentMessage,
    concurrency: 4,
  });
  const first = await service.syncMessages({ accountId: 'a@test', from, to, messages: buildMessages() });
  assert.ok(first.inserted > 0, '首轮应有新增');

  const second = await service.syncMessages({ accountId: 'a@test', from, to, messages: buildMessages() });
  assert.equal(second.inserted, 0, `第二轮不应新增任何邮件，实际 ${second.inserted}`);
  assert.equal(second.analyzed, 0, `第二轮不应重新分析，实际 ${second.analyzed}`);
  assert.equal(second.skipped, first.analyzed, '已分析过的邮件应全部走 skip');
  assert.equal(second.modelFailed, 0, '第二轮不应再调用模型');
});

test('reused Message-IDs inside one run stay as separate archived mails', async () => {
  const run = await runWith(4);
  const spring = run.archived.filter((r) => /示例出行/.test(r.subject));
  assert.equal(spring.length, 2, `复用 Message-ID 的两封应各自留档，实际 ${spring.length}`);
  assert.notEqual(spring[0].position, spring[1].position, '两封的岗位不应互相覆盖');
});
