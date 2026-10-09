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

function harness({ classifier, concurrency, triage }) {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const service = createSyncService({
    repository,
    classifier,
    analysisVersion: 'test-v1',
    triage: triage || triageRecruitmentMessage,
    concurrency,
  });
  return { repository, service };
}

const window = {
  accountId: 'a@qq.com',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-12-31T23:59:59.999Z',
};

function mail(uid, receivedAt = `2026-05-0${uid}T08:00:00.000Z`) {
  return {
    messageId: `<m-${uid}@example.test>`,
    receivedAt,
    sender: '示例科技 <recruit@example.test>',
    subject: '示例科技技术面试邀请',
    text: '我们邀请你参加技术面试，请确认时间。',
    folder: 'INBOX',
    uidValidity: 'v1',
    uid: String(uid),
  };
}

// 上游卡死（AbortSignal.timeout）不应该重试：重试只会把 1×timeout 变成 3×timeout。
// 断言「向上游发了几次」，而不是断言耗时——耗时是探针的上限，不是实测值。
test('a timed-out request is not retried', async () => {
  let calls = 0;
  const timeoutError = Object.assign(new Error('model request timed out after 60000ms'), { code: 'MODEL_TIMEOUT' });
  const { service } = harness({
    classifier: async () => { calls += 1; throw timeoutError; },
  });

  const summary = await service.syncMessages({ ...window, messages: [mail(1)] });

  assert.equal(calls, 1, `超时只应请求 1 次，实际 ${calls} 次`);
  assert.equal(summary.modelFailed, 1);
  assert.equal(summary.failures[0].error, 'MODEL_TIMEOUT');
});

test('permanent model configuration failures stop dispatch without losing pending mail', async () => {
  for (const code of ['MODEL_NOT_FOUND', 'MODEL_AUTH_FAILED', 'MODEL_ACCESS_DENIED', 'MODEL_PAYMENT_REQUIRED', 'MODEL_CONFIG_INVALID']) {
    let calls = 0;
    const { service } = harness({ concurrency: 1, classifier: async () => {
      calls += 1;
      throw Object.assign(new Error('配置不可用'), { code });
    } });
    const result = await service.syncMessages({ ...window, messages: [mail(1), mail(2), mail(3)] });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, code);
    assert.equal(result.remaining, 2);
    assert.equal(result.retryFrom, mail(1).receivedAt);
    database.close();
    database = undefined;
  }
});

// 没有 code 的错误（fetch 的 TypeError、DNS 解析失败等）也必须带上 message。
// 只记类型名的话，一次 61 封失败的回填在报告里全是同一个 "TypeError"，
// 无法区分网络抖动 / 上游拒绝 / 上游卡死，等于没有诊断信息。
test('a failure without an error code still records its message', async () => {
  const { service } = harness({
    // 不设 code——真实 fetch 的连接层错误就是这样（TypeError: fetch failed）。
    classifier: async () => { throw new TypeError('fetch failed'); },
  });

  const summary = await service.syncMessages({ ...window, messages: [mail(1)] });

  assert.equal(summary.modelFailed, 1);
  const [failure] = summary.failures;
  assert.equal(failure.error, 'TypeError', '类型名仍作为 error 字段，便于按类聚合');
  assert.equal(failure.message, 'fetch failed', 'message 必须保留，否则无从诊断');
});

test('a coded failure records both the code and the message', async () => {
  const { service } = harness({
    classifier: async () => {
      throw Object.assign(new Error('model request failed with status 503'), { code: 'MODEL_UNAVAILABLE' });
    },
  });

  const summary = await service.syncMessages({ ...window, messages: [mail(1)] });

  assert.equal(summary.failures[0].error, 'MODEL_UNAVAILABLE');
  assert.match(summary.failures[0].message, /503/);
});

test('a rate-limited request is not retried', async () => {
  let calls = 0;
  const rateError = Object.assign(new Error('rate limited'), { code: 'MODEL_RATE_LIMITED' });
  const { service } = harness({
    classifier: async () => { calls += 1; throw rateError; },
  });

  await service.syncMessages({ ...window, messages: [mail(1)] });
  assert.equal(calls, 1, `限流只应请求 1 次，实际 ${calls} 次`);
});

test('a truncated response is not retried', async () => {
  let calls = 0;
  const truncError = Object.assign(new Error('model output was truncated'), { code: 'MODEL_OUTPUT_TRUNCATED' });
  const { service } = harness({
    classifier: async () => { calls += 1; throw truncError; },
  });

  await service.syncMessages({ ...window, messages: [mail(1)] });
  assert.equal(calls, 1, `截断只应请求 1 次，实际 ${calls} 次`);
});

// 负向对照：可重试错误（网络抖动）必须仍然重试 3 次。
// 没有这条，上面三条断言可能是「因为把重试整个删掉」而恒真。
test('a transient network error is still retried up to the limit', async () => {
  let calls = 0;
  const { service } = harness({
    classifier: async () => { calls += 1; throw new TypeError('fetch failed'); },
  });

  await service.syncMessages({ ...window, messages: [mail(1)] });
  assert.equal(calls, 3, `可重试错误应尝试 3 次，实际 ${calls} 次`);
});

// 限流与超时的处置必须不同：限流是「上游整体不可用」，继续打只会白白消耗配额、
// 加剧封禁，所以要中断整轮；超时只是这一封的问题，不该牵连后面的邮件。
// 少了这条，RUN_ABORTING_ERROR_CODES 被清空也不会有任何测试报警。
test('a rate limit aborts the whole run instead of hammering the upstream', async () => {
  let calls = 0;
  const { service } = harness({
    classifier: async () => {
      calls += 1;
      throw Object.assign(new Error('rate limited'), { code: 'MODEL_RATE_LIMITED' });
    },
    concurrency: 1,
  });

  const summary = await service.syncMessages({ ...window, messages: [mail(1), mail(2), mail(3)] });

  assert.equal(calls, 1, `限流后不应继续请求上游，实际请求 ${calls} 次`);
  assert.equal(summary.modelFailed, 1, '中断后不应把剩余邮件逐个记为失败');
  assert.equal(summary.candidates, 3, '候选计数在阶段 A 已全部完成，不受阶段 B 中断影响');
});

// 超时不应中断整轮同步：后面的邮件必须继续处理。
test('a timeout on one message does not abort the rest of the run', async () => {
  let index = 0;
  const timeoutError = Object.assign(new Error('timed out'), { code: 'MODEL_TIMEOUT' });
  const { repository, service } = harness({
    classifier: async () => {
      index += 1;
      if (index === 2) throw timeoutError;
      return {
        isJobRelated: true,
        company: index === 1 ? '甲公司' : '丙公司',
        position: index === 1 ? '产品经理' : '运营专员',
        status: index === 1 ? '已投递' : '面试',
        confidence: 0.9,
        evidence: 'e',
        nextAction: 'n',
        needsReview: false,
      };
    },
  });

  const summary = await service.syncMessages({ ...window, messages: [mail(1), mail(2), mail(3)] });

  assert.equal(summary.modelFailed, 1, '只应统计一封失败');
  assert.equal(summary.inserted, 2, '失败封之后的邮件仍应入库');
  const threads = repository.listThreads({});
  assert.equal(threads.length, 2, `应保留 2 个线程，实际 ${threads.length}`);
  assert.ok(threads.some((t) => t.company === '丙公司'), '第三封邮件不能被第二封的超时牵连丢弃');
});

// —— 「非求职邮件不得占用流程状态」契约 ————————————————————————————————
// 背景：deriveStatusFromEvidence 只扫标题，邮件只要在标题里引用了原邮件主题就会误判。
// 系统撤回失败通知的标题形如「通知：[撤回邮件失败]回复：来自某公司的
// 面试邀请」——「面试邀请」只是被引用的原主题，正文没有任何招聘内容。evidenceStatus 的
// 优先级高于模型输出，会把 llm-service validateOutput 里的降级覆盖掉，于是这封退信
// 以 status=面试 落库。看板上就是「面了但没进进度列表」，自相矛盾。
// 退信类邮件现在由 triage 的 system 规则在进模型之前就拦掉了（第一道防线，见
// test/triage.test.js）。但那只是词表匹配，挡不住所有形态——所以落库前仍要有这道
// 兜底：模型判 false 之后，任何来源的证据都不能把状态顶回流程中。
// 下面两条用「全部放行」的 triage stub，专门验证这第二道防线自身的行为。
const passThroughTriage = () => ({ decision: 'analyze', reason: 'stub', signal: 'generic' });

function bounceMail(uid = 1) {
  return {
    messageId: `<bounce-${uid}@example.test>`,
    receivedAt: '2026-05-20T08:00:00.000Z',
    sender: 'postmaster@163.com',
    subject: '通知：[撤回邮件失败]回复：来自示例科技的面试邀请',
    text: '您对邮件进行了撤回操作，但是撤回失败。原因：对方邮件地址无效。',
    folder: 'INBOX',
    uidValidity: 'v1',
    uid: String(uid),
  };
}

const nonJobAnalysis = {
  isJobRelated: false,
  company: '',
  position: '',
  status: '已结束',
  confidence: 0.2,
  evidence: '退信通知，正文无招聘内容',
  nextAction: '不写入招聘进度列表',
  needsReview: false,
};

test('a bounce notice quoting an interview subject is archived, not counted as an interview', async () => {
  const { repository, service } = harness({
    classifier: async () => ({ ...nonJobAnalysis }),
    triage: passThroughTriage,
  });

  await service.syncMessages({ ...window, messages: [bounceMail()] });

  const rows = repository.listAnalyses({ accountId: window.accountId, jobRelatedOnly: false });
  assert.equal(rows.length, 1, 'triage 放行后这封邮件应入库，才能验证落库前的降级');
  assert.equal(Boolean(rows[0].isJobRelated), false, '退信不该被算作求职邮件');
  assert.equal(rows[0].status, '已结束', '标题里的「面试邀请」是引用原文，不能让退信占着面试状态');
  assert.equal(Boolean(rows[0].needsReview), true, '降级说明模型与证据打架，必须可复核');
  assert.equal(repository.listThreads({}).length, 0, '非求职邮件不该在线程里留下空占位');
});

// 负向对照：同一封退信，如果模型判定它确实是求职邮件（isJobRelated=true），
// 证据路径必须照常把状态定为面试。这一条防止上面的降级逻辑写成「一律清零」——
// 那样测试 1 照样绿，但所有真面试邀请都会被误降级，测试对生产完全失去守卫作用。
test('the downgrade does not override a model that confirms the mail is job related', async () => {
  const { repository, service } = harness({
    triage: passThroughTriage,
    classifier: async () => ({
      ...nonJobAnalysis,
      isJobRelated: true,
      company: '示例科技',
      position: '技术工程师',
      status: '面试',
      confidence: 0.9,
      needsReview: false,
    }),
  });

  await service.syncMessages({ ...window, messages: [bounceMail()] });

  const rows = repository.listAnalyses({ accountId: window.accountId, jobRelatedOnly: false });
  assert.equal(Boolean(rows[0].isJobRelated), true, '模型确认是求职邮件时不得降级 isJobRelated');
  assert.equal(rows[0].status, '面试', '真面试邀请必须保住面试状态');
  assert.equal(Boolean(rows[0].needsReview), false, '没有被降级就不该无端标复核');
  assert.equal(repository.listThreads({}).length, 1, '真面试应落在线程里');
});

// 模型自己就判已结束、且没有和证据冲突时，不该无端标复核——否则降级标记会
// 淹掉真正需要人工看的那些邮件。这条守的是 needsReview 的另一半。
test('a non-job mail the model already archived is not flagged for review', async () => {
  const { repository, service } = harness({ classifier: async () => ({ ...nonJobAnalysis }) });

  // 真实库样本：某公司校招自动回复。正文提到「面试」但没有流程信号，
  // deriveStatusFromEvidence 推不出状态，模型判非求职——此时没有冲突，
  // 降级不该触发，复核队列也就不该被这类噪音淹没。
  await service.syncMessages({
    ...window,
    messages: [{
      ...bounceMail(),
      sender: '',
      subject: '校招',
      text: '同学你好，感谢你关注并参与春季校园招聘，你可以登录校招官网查看招聘进展。'
        + '面试官会结合笔试成绩和简历进行综合比较，请耐心等待后续流程。以上为自动回复，请勿回复。',
    }],
  });

  const rows = repository.listAnalyses({ accountId: window.accountId, jobRelatedOnly: false });
  assert.equal(rows.length, 1, '这类系统通知应正常入库，只是不进进度列表');
  assert.equal(rows[0].status, '已结束');
  assert.equal(Boolean(rows[0].isJobRelated), false);
  assert.equal(Boolean(rows[0].needsReview), false, '没有降级就不该标复核，否则复核队列会被噪音淹没');
});
