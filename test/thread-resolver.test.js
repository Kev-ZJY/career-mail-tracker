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

test('fabricated position on a brand-new thread is stripped and flagged', () => {
  const placement = resolveThreadPlacement({
    threads: [],
    analysis: { status: '面试', company: '丙公司', position: '资深区块链工程师', threadRef: 'new' },
    message: { subject: '面试通知', text: '诚邀您参加面试' },  // 原文无岗位词
  });
  assert.equal(placement.sanitizedAnalysis.position, '');
  assert.equal(placement.sanitizedAnalysis.needsReview, true);
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

test('position drift allowed when email explicitly mentions different position', () => {
  const threads = [{ id: 5, company: '甲科技', position: '后端', status: '已投递' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '甲科技', position: '前端', threadRef: 5 },
    message: { subject: '前端岗位面试邀请', text: '邀请您参加前端岗位面试' },
  });
  assert.equal(placement.mainThreadId, 5);
  assert.equal(placement.sanitizedAnalysis.position, '前端');
});

test('position stripped when not in email even with threadRef', () => {
  const threads = [{ id: 6, company: '甲科技', position: '后端', status: '已投递' }];
  const placement = resolveThreadPlacement({
    threads,
    analysis: { status: '面试', company: '甲科技', position: '数据工程师', threadRef: 6 },
    message: { subject: '面试邀请', text: '诚邀您参加面试' },
  });
  assert.equal(placement.mainThreadId, 6);
  assert.equal(placement.sanitizedAnalysis.position, '');
});