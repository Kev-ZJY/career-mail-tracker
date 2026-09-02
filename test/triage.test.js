import test from 'node:test';
import assert from 'node:assert/strict';
import { triageRecruitmentMessage } from '../src/domain/triage.js';

test('triage ignores recruitment events and job recommendations before model analysis', () => {
  const activity = triageRecruitmentMessage({ subject: '8月招聘活动预告', text: '欢迎报名参加线上招聘活动和宣讲会。' });
  const recommendation = triageRecruitmentMessage({ subject: '为你推荐匹配岗位', text: '根据你的偏好推荐热门职位。' });
  const promotion = triageRecruitmentMessage({ subject: 'AI 产品经理培训生开放投递中', text: '欢迎投递，查看申请攻略和岗位机会。' });
  const applicationGuide = triageRecruitmentMessage({ subject: '首轮申请：课程升级后，有哪些新机会？（附全攻略）', text: '申请攻略和机会介绍。' });

  assert.equal(activity.decision, 'ignore');
  assert.equal(recommendation.decision, 'ignore');
  assert.equal(promotion.decision, 'ignore');
  assert.equal(applicationGuide.decision, 'ignore');
  assert.match(activity.reason, /活动|宣讲/);
  assert.match(recommendation.reason, /推荐/);
});

test('triage sends personal recruitment progress signals to model analysis', () => {
  const cases = [
    ['面试邀请', '请你参加技术面试，面试链接：https://example.test/interview', 'interview'],
    ['在线测评通知', '请完成测评，截止时间为明天。', 'assessment'],
    ['申请已提交', '我们已收到你的申请。', 'submitted'],
    ['Offer 录用通知', '我们希望向你发出 Offer。', 'offer'],
    ['招聘流程结束通知', '你的本次招聘流程已结束。', 'ended'],
  ];

  for (const [subject, text, expectedSignal] of cases) {
    const result = triageRecruitmentMessage({ subject, text });
    assert.equal(result.decision, 'analyze', subject);
    assert.equal(result.signal, expectedSignal, subject);
  }
});

test('satisfaction survey without an end signal stays out of the recruitment list', () => {
  const result = triageRecruitmentMessage({
    subject: '【小红书】面试满意度调研',
    text: '我是小红书的HR，感谢您参加视频用户产品实习生的面试，现邀请您对本轮面试做出评价。问卷为匿名，请放心填写。',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'survey');
});

test('interview experience survey without an end signal is ignored', () => {
  const result = triageRecruitmentMessage({
    subject: '【快手面试体验】',
    text: '感谢您参加快手面试，邀请您反馈本次面试体验。',
  });
  assert.equal(result.decision, 'ignore');
});

test('survey carrying an explicit process-end signal is kept as an ended signal', () => {
  const result = triageRecruitmentMessage({
    subject: '【腾讯】面试反馈问卷',
    text: '感谢你的关注与参与，本招聘流程已结束，诚邀您填写面试反馈问卷。',
  });
  assert.equal(result.decision, 'analyze');
});

test('regular interview invitation still flows to analysis', () => {
  const result = triageRecruitmentMessage({
    subject: '【小红书】面试邀请',
    text: '现邀请您参加视频用户产品实习生的面试，会议链接：https://meeting.tencent.com/dm/abc',
  });
  assert.equal(result.decision, 'analyze');
});

test('challenge/contest marketing mail is ignored even when it mentions interviews', () => {
  const result = triageRecruitmentMessage({
    subject: '四大德勤数字化精英挑战赛，官方证书+面试绿通',
    text: '德勤数字化精英挑战赛报名开启，优胜者直通面试！',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'activity');
});

test('recruiter referral/club invitation mail is ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '德勤俱乐部 x 数字化精英挑战赛 - 星推官邀请函', text: '诚邀你成为星推官，推荐同学参赛赢大奖' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '2026 Deloitte Club Member 推荐官计划', text: '加入推荐官计划' }).decision, 'ignore');
});

test('campus recruitment launch and invitation-to-apply mails are ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '百度2027届暑期实习招聘投递邀请', text: '百度2027届暑期实习招聘已启动，诚邀你投递' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '【百度】2027届校招已启动，诚邀你投递！', text: '校招岗位现已开放' }).decision, 'ignore');
});

test('account/system and holiday mails are ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '德勤中国招聘官网注册邮箱激活码：854091', text: '你的激活码是 854091' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '您好，您的离职交接已完成。', text: '离职交接流程已完成' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '马跃新程 恭贺新禧! Happy New Year of the Horse', text: '恭贺新禧' }).decision, 'ignore');
});

test('real application confirmation is not over-filtered', () => {
  assert.equal(triageRecruitmentMessage({ subject: '【小红书招聘】简历投递成功 - 张三 - 视频用户产品实习生', text: '我们已收到你投递的视频用户产品实习生职位简历' }).decision, 'analyze');
});

test('interview satisfaction survey is ignored even though subject contains 面试', () => {
  const result = triageRecruitmentMessage({
    subject: '北京趣拿软件科技有限公司面试满意度问卷',
    text: '非常感谢你参加北京趣拿软件科技有限公司的面试。为进一步改善候选人的面试体验，诚邀你花费1分钟填写以下问卷。此问卷仅用于招聘流程优化，不与面试结果关联。',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'survey');
});

test('survey with explicit end wording still flows to ended analysis', () => {
  const result = triageRecruitmentMessage({
    subject: '腾讯校园招聘——邀请您填写面试反馈问卷',
    text: '您的面试流程目前已结束，诚邀您填写面试反馈问卷。',
  });
  assert.equal(result.decision, 'analyze');
});
