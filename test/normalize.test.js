import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStatusFromEvidence,
  deriveEventWindowFromEvidence,
  extractActionLink,
  extractInterviewLink,
  normalizeCompany,
  normalizePositionName,
} from '../src/domain/normalize.js';

test('deriveEventWindowFromEvidence parses explicit Beijing assessment windows', () => {
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '【示例网络招聘】测验通知',
    text: '测验开放时间：2026-09-07 10:00～2026-09-10 00:00',
    receivedAt: '2026-09-07T02:18:12.000Z',
  }), {
    eventStart: '2026-09-07T02:00:00.000Z',
    eventEnd: '2026-09-09T16:00:00.000Z',
  });
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '示例商城集团邀请你参加在线笔试',
    text: '考试时间：(北京时间,UTC+08:00)2026-09-12 10:00:00 -- 11:40:00',
    receivedAt: '2026-09-10T08:38:59.000Z',
  }), {
    eventStart: '2026-09-12T02:00:00.000Z',
    eventEnd: '2026-09-12T03:40:00.000Z',
  });
});

test('deriveEventWindowFromEvidence uses receipt time for deadline-only and generic rolling windows', () => {
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '线上测评邀请',
    text: '最晚务必在（北京时间）2026/09/12 23:59前完成该评估。',
    receivedAt: '2026-09-10T01:42:02.000Z',
  }), {
    eventStart: '2026-09-10T01:42:02.000Z',
    eventEnd: '2026-09-12T15:59:00.000Z',
  });
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '自然日测评邀请',
    text: '测评有效期为 5 个自然日。',
    receivedAt: '2026-09-09T08:59:05.000Z',
  }), {
    eventStart: '2026-09-09T08:59:05.000Z',
    eventEnd: '2026-09-14T08:59:05.000Z',
  });
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '请在邮件规定时间内完成能力测评',
    text: '请在3个工作日内完成校园招聘能力测评。',
    receivedAt: '2026-09-11T02:42:23.000Z',
  }), {
    eventStart: '2026-09-11T02:42:23.000Z',
    eventEnd: '2026-09-16T02:42:23.000Z',
  });
  assert.deepEqual(deriveEventWindowFromEvidence({
    subject: '请完成能力测评',
    text: '请在1个工作日内完成。',
    receivedAt: '2026-09-11T17:30:00.000Z',
  }), {
    eventStart: '2026-09-11T17:30:00.000Z',
    eventEnd: '2026-09-13T17:30:00.000Z',
  });
});

test('normalizeCompany only cleans generic formatting and never applies hidden aliases', () => {
  assert.equal(normalizeCompany('  示例   科技有限公司  '), '示例 科技有限公司');
  assert.equal(normalizeCompany('Example Technology Ltd.'), 'Example Technology Ltd.');
  assert.equal(normalizeCompany(''), '');
});

test('normalizePositionName only cleans whitespace and preserves model semantics', () => {
  assert.equal(normalizePositionName('  AI 产品经理（直播产品）-27秋招职位  '), 'AI 产品经理（直播产品）-27秋招职位');
  assert.equal(normalizePositionName('Campus Recruitment 2027 Example Role 1'), 'Campus Recruitment 2027 Example Role 1');
});

test('strong current-event evidence deterministically corrects noisy model statuses', () => {
  assert.equal(deriveStatusFromEvidence({ subject: '【示例硬件校招测评】2027届校园招聘', text: '链接：...' }), '测评中');
  assert.equal(deriveStatusFromEvidence({ subject: '示例网络音乐娱乐集团校园招聘投递成功通知', text: 'FAQ：筛选未通过是否有通知？' }), '已投递');
  assert.equal(deriveStatusFromEvidence({ subject: '【示例交通招聘】简历成功投递通知', text: '当前投递流程结束后才能再次投递' }), '已投递');
  assert.equal(deriveStatusFromEvidence({ subject: '示例出行-应聘状态变更通知', text: '您的简历已进入人才库，祝您未来求职顺利' }), '已结束');
  assert.equal(deriveStatusFromEvidence({ subject: '示例出行-应聘状态变更通知', text: '您的简历已进入复筛' }), '已投递');
  assert.equal(deriveStatusFromEvidence({
    subject: '来自示例制造科技集团的AI面试邀请',
    text: '邀请您参加示例制造校园招聘线上测评，测评结果会作为面试关键依据。',
  }), '测评中');
});

test('extractActionLink prefers the labeled assessment link over confirmation and unsubscribe links', () => {
  const longToken = 'a'.repeat(260);
  const assessmentUrl = `https://assessment.example.test/start?token=${longToken}`;
  const html = `
    <a href="https://tracking.example.test/confirm-yes">参加 / Yes</a>
    <p>作答链接：<a href="${assessmentUrl}">开始测评</a></p>
    <a href="https://tracking.example.test/unsubscribe">点击这里取消订阅</a>
  `;
  assert.equal(extractActionLink({ html }), assessmentUrl);
});

test('extractActionLink finds an assessment-like URL after a generic link label in plain text', () => {
  assert.equal(extractActionLink({
    text: '链接：https://talent.example.test/e-entrance/token https://social.example.test/article',
  }), 'https://talent.example.test/e-entrance/token');
});

test('extractInterviewLink prefers the meeting link over download and unsubscribe links', () => {
  const interviewUrl = 'https://meeting.example.test/room/123';
  const html = `
    <a href="https://download.example.test/client">下载会议客户端</a>
    <p>面试链接：<a href="${interviewUrl}">进入面试</a></p>
    <a href="https://tracking.example.test/unsubscribe">取消订阅</a>
  `;
  assert.equal(extractInterviewLink({ html }), interviewUrl);
});
