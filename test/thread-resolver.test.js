import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveThreadPlacement } from '../src/domain/thread-resolver.js';

const normalize = (v) => String(v || '').trim().toLowerCase();

test('interview email without position drifts onto the only active interview thread and never invents a position', () => {
  const threads = [{ id: 7, company: '甲科技', position: '后端开发', status: '面试' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '甲科技', position: '', threadRef: 7 },
    message: { subject: '面试邀请', text: '请您参加周一上午十点面试' },
  });
  assert.equal(placement.mainThreadId, 7);
});

test('assessment applying to multiple positions fans out to every referenced thread of the same company', () => {
  const threads = [
    { id: 1, company: '甲科技', position: '后端', status: '已投递' },
    { id: 2, company: '甲科技', position: '前端', status: '已投递' },
    { id: 3, company: '乙公司', position: '测试', status: '已投递' },
  ];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '测评中', company: '甲科技', position: '', threadRef: 'new', appliesTo: [1, 2] },
    message: { subject: '在线测评', text: '请完成测评，本次测评覆盖您申请的全部岗位' },
  });
  assert.deepEqual(placement.fanoutIds.sort(), [1, 2]);
});

test('an all-position assessment fans out locally without exposing historical thread ids to the model', () => {
  const placement = resolveThreadPlacement({
    threads: [
      { id: 1, company: '青岚', position: '前端工程师', status: '已投递' },
      { id: 2, company: '青岚', position: '后端工程师', status: '已投递' },
      { id: 3, company: '青岚音乐', position: '产品经理', status: '已投递' },
    ],
    analysis: { company: '青岚', position: '前端工程师', status: '测评中', threadRef: 'new', appliesToAll: true },
    message: { receivedAt: '2026-09-01T00:00:00.000Z' },
  });
  assert.deepEqual(placement.fanoutIds.sort(), [1, 2]);
});

test('thread placement preserves the model position instead of applying a substring filter', () => {
  const placement = resolveThreadPlacement({
    threads: [],
    analysis: { status: '面试', company: '丙公司', position: '资深区块链工程师', threadRef: 'new' },
    message: { subject: '面试通知', text: '诚邀您参加面试' },  // 原文无岗位词
  });
  assert.equal(placement.sanitizedAnalysis.position, '资深区块链工程师');
  assert.equal(placement.sanitizedAnalysis.needsReview, false);
});

test('ended threads are not resurrected by threadRef alone', () => {
  const threads = [{ id: 9, company: '丁公司', position: '测试开发', status: '已结束' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '丁公司', position: '', threadRef: 9 },
    message: { subject: '面试邀请', text: '诚邀您参加面试' },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.needsReview, true);
});

test('new thread with position mentioned in email keeps position', () => {
  const placement = resolveThreadPlacement({
    threads: [],
    analysis: { status: '已投递', company: '戊公司', position: '前端工程师', threadRef: 'new' },
    message: { subject: '投递确认', text: '您申请的前端工程师岗位已收到简历' },
  });
  assert.equal(placement.sanitizedAnalysis.position, '前端工程师');
  assert.equal(placement.created, true);
});

test('an explicit new threadRef still merges a positionless receipt into the only unknown-position route', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 18,
      company: '示例科技',
      position: '',
      status: '已投递',
      latestReceivedAt: '2026-09-03T11:17:43.000Z',
    }],
    analysis: {
      status: '已投递',
      company: '示例科技',
      position: '',
      threadRef: 'new',
    },
    message: {
      receivedAt: '2026-09-10T10:37:00.000Z',
      subject: '投递成功通知',
      text: '我们已经收到你的简历并会认真评估。',
    },
  });

  assert.equal(placement.mainThreadId, 18);
  assert.equal(placement.created, false);
  assert.equal(placement.sanitizedAnalysis.position, '');
  assert.equal(placement.sanitizedAnalysis.needsReview, true);
});

test('position grounding ignores harmless whitespace differences in the email', () => {
  const placement = resolveThreadPlacement({
    threads: [],
    analysis: {
      status: '测评中',
      company: '示例旅行',
      position: 'AI产品经理（2027届秋招）',
      threadRef: 'new',
    },
    message: {
      subject: '示例旅行能力测评',
      text: '感谢投递示例旅行集团校园招聘AI 产品经理（2027届秋招）职位。',
    },
  });
  assert.equal(placement.sanitizedAnalysis.position, 'AI产品经理（2027届秋招）');
});

test('threadRef to different company is ignored', () => {
  const threads = [{ id: 10, company: '甲科技', position: '后端', status: '已投递' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '乙公司', position: '', threadRef: 10 },
    message: { subject: '面试邀请', text: '诚邀您参加面试' },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
});

test('a wrong-company threadRef falls back to the only same-company follow-up route', () => {
  const threads = [
    {
      id: 10,
      company: '甲科技',
      position: '',
      status: '已投递',
      latestReceivedAt: '2026-09-08T02:00:00.000Z',
    },
    {
      id: 11,
      company: '乙公司',
      position: '',
      status: '已投递',
      latestReceivedAt: '2026-09-09T02:00:00.000Z',
    },
  ];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '测评中', company: '甲科技', position: '', threadRef: 11 },
    message: {
      receivedAt: '2026-09-10T02:00:00.000Z',
      subject: '在线测评通知',
      text: '感谢投递，现邀请您完成测评。',
    },
  });
  assert.equal(placement.mainThreadId, 10);
  assert.equal(placement.created, false);
});

test('appliesTo filters out threads from other companies', () => {
  const threads = [
    { id: 1, company: '甲科技', position: '后端', status: '已投递' },
    { id: 2, company: '乙公司', position: '前端', status: '已投递' },
  ];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '测评中', company: '甲科技', position: '', threadRef: 'new', appliesTo: [1, 2] },
    message: { subject: '测评', text: '测评链接' },
  });
  assert.deepEqual(placement.fanoutIds, [1]);
});

test('appliesTo filters out ended threads', () => {
  const threads = [
    { id: 1, company: '甲科技', position: '后端', status: '已投递' },
    { id: 2, company: '甲科技', position: '前端', status: '已结束' },
  ];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '测评中', company: '甲科技', position: '', threadRef: 'new', appliesTo: [1, 2] },
    message: { subject: '测评', text: '测评链接' },
  });
  assert.deepEqual(placement.fanoutIds, [1]);
});

test('a threadRef cannot overwrite an active thread with a different explicit position', () => {
  const threads = [{ id: 5, company: '甲科技', position: '后端', status: '已投递' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '甲科技', position: '前端', threadRef: 5 },
    message: { subject: '前端岗位面试邀请', text: '邀请您参加前端岗位面试' },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.position, '前端');
});

test('a different model-extracted position creates a separate application', () => {
  const threads = [{ id: 6, company: '甲科技', position: '后端', status: '已投递' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '甲科技', position: '数据工程师', threadRef: 6 },
    message: { subject: '面试邀请', text: '诚邀您参加面试' },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.position, '数据工程师');
});

test('a positionless message cannot drift onto a stale historical position by threadRef', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 21,
      company: '示例互联',
      position: '示例岗位乙',
      status: '面试',
      latestReceivedAt: '2026-04-17T03:54:42.000Z',
    }],
    analysis: { status: '已投递', company: '示例互联', position: '', threadRef: 21 },
    message: {
      receivedAt: '2026-09-03T11:17:43.000Z',
      subject: '示例互联校园招聘投递成功通知',
      text: '我们已经收到你的简历并会认真评估。',
    },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.position, '');
  assert.equal(placement.sanitizedAnalysis.needsReview, true);
});

test('a recent same-company route can receive a positionless follow-up assessment', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 22,
      company: 'ExampleCommerce',
      position: '示例全球培训生',
      status: '已投递',
      latestReceivedAt: '2026-08-31T13:08:31.000Z',
    }],
    analysis: { status: '测评中', company: 'ExampleCommerce', position: '', threadRef: 22 },
    message: {
      receivedAt: '2026-09-10T01:42:02.000Z',
      subject: '【ExampleCommerce】示例全球培训生计划线上测评邀请',
      text: '欢迎参加示例全球培训生计划，请完成线上笔试。',
    },
  });
  assert.equal(placement.mainThreadId, 22);
  assert.equal(placement.sanitizedAnalysis.position, '示例全球培训生');
});

test('a positionless submitted receipt merges by company and unknown position even without sender identity', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 30,
      company: '示例科技',
      position: '',
      status: '已投递',
      latestReceivedAt: '2026-09-03T11:17:43.000Z',
    }],
    analysis: { status: '已投递', company: '示例科技', position: '', threadRef: 30 },
    message: {
      receivedAt: '2026-09-10T12:58:43.000Z',
      subject: '投递成功通知',
      text: '我们已经收到你的简历。',
    },
  });
  assert.equal(placement.mainThreadId, 30);
  assert.equal(placement.created, false);
  assert.equal(placement.sanitizedAnalysis.position, '');
});

test('a positionless receipt prefers the unknown-position route over same-company named routes', () => {
  const placement = resolveThreadPlacement({
    threads: [
      { id: 40, company: '示例科技', position: '前端工程师', status: '已投递', latestReceivedAt: '2026-09-09T00:00:00.000Z' },
      { id: 41, company: '示例科技', position: '', status: '已投递', latestReceivedAt: '2026-08-01T00:00:00.000Z' },
    ],
    analysis: { status: '已投递', company: '示例科技', position: '', threadRef: 40 },
    message: {
      receivedAt: '2026-09-10T00:00:00.000Z',
      sender: 'hr@example.test',
      subject: '已收到申请',
      text: '感谢投递，我们已收到你的简历。',
    },
  });
  assert.equal(placement.mainThreadId, 41);
  assert.equal(placement.sanitizedAnalysis.position, '');
});

test('a positionless submitted receipt merges when the recent route has the same organization sender identity', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 31,
      company: '示例科技',
      position: '',
      status: '已投递',
      latestReceivedAt: '2026-09-03T11:17:43.000Z',
      latestSender: 'recruiting@example.test',
    }],
    analysis: { status: '已投递', company: '示例科技', position: '', threadRef: 'new' },
    message: {
      receivedAt: '2026-09-09T12:58:43.000Z',
      sender: 'recruiting@example.test',
      subject: '投递成功通知',
      text: '我们已经收到你的简历。',
    },
  });
  assert.equal(placement.mainThreadId, 31);
  assert.equal(placement.created, false);
  assert.equal(placement.sanitizedAnalysis.position, '');
});

test('same sender identity cannot merge a positionless receipt into a named application', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 32,
      company: '示例科技',
      position: '软件产品经理',
      status: '已投递',
      latestReceivedAt: '2026-09-03T11:17:43.000Z',
      latestSender: 'recruiting@example.test',
    }],
    analysis: { status: '已投递', company: '示例科技', position: '', threadRef: 'new' },
    message: {
      receivedAt: '2026-09-09T12:58:43.000Z',
      sender: 'recruiting@example.test',
      subject: '投递成功通知',
      text: '我们已经收到你的简历。',
    },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.position, '');
});

test('a positionless follow-up assessment merges into the only recent company route even when the model says new', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 22,
      company: '示例科技',
      position: '产品经理',
      status: '已投递',
      latestReceivedAt: '2026-08-31T13:08:31.000Z',
    }],
    analysis: { status: '测评中', company: '示例科技', position: '', threadRef: 'new' },
    message: {
      receivedAt: '2026-09-10T01:42:02.000Z',
      subject: '线上测评邀请',
      text: '您已通过简历评估，请完成线上测评。',
    },
  });
  assert.equal(placement.mainThreadId, 22);
  assert.equal(placement.created, false);
  assert.equal(placement.sanitizedAnalysis.position, '产品经理');
});

test('an explicit new reference still creates a separate positionless receipt', () => {
  const placement = resolveThreadPlacement({
    threads: [{
      id: 22,
      company: '示例科技',
      position: '产品经理',
      status: '已投递',
      latestReceivedAt: '2026-08-31T13:08:31.000Z',
    }],
    analysis: { status: '已投递', company: '示例科技', position: '', threadRef: 'new' },
    message: {
      receivedAt: '2026-09-10T01:42:02.000Z',
      subject: '投递成功',
      text: '已收到你的简历。',
    },
  });
  assert.equal(placement.mainThreadId, null);
  assert.equal(placement.created, true);
  assert.equal(placement.sanitizedAnalysis.position, '');
});
