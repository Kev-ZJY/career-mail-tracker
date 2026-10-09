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
    subject: '【示例社区】面试满意度调研',
    text: '我是示例社区的HR，感谢您参加示例产品实习生的面试，现邀请您对本轮面试做出评价。问卷为匿名，请放心填写。',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'survey');
});

test('interview experience survey without an end signal is ignored', () => {
  const result = triageRecruitmentMessage({
    subject: '【示例影像面试体验】',
    text: '感谢您参加示例影像面试，邀请您反馈本次面试体验。',
  });
  assert.equal(result.decision, 'ignore');
});

test('survey carrying an explicit process-end signal is kept as an ended signal', () => {
  const result = triageRecruitmentMessage({
    subject: '【示例网络】面试反馈问卷',
    text: '感谢你的关注与参与，本招聘流程已结束，诚邀您填写面试反馈问卷。',
  });
  assert.equal(result.decision, 'analyze');
});

test('regular interview invitation still flows to analysis', () => {
  const result = triageRecruitmentMessage({
    subject: '【示例社区】面试邀请',
    text: '现邀请您参加示例产品实习生的面试，会议链接：https://meeting.example.test/dm/abc',
  });
  assert.equal(result.decision, 'analyze');
});

test('challenge/contest marketing mail is ignored even when it mentions interviews', () => {
  const result = triageRecruitmentMessage({
    subject: '示例咨询数字化精英挑战赛，官方证书+面试绿通',
    text: '示例咨询数字化精英挑战赛报名开启，优胜者直通面试！',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'activity');
});

test('recruiter referral/club invitation mail is ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '示例咨询俱乐部 x 数字化精英挑战赛 - 星推官邀请函', text: '诚邀你成为星推官，推荐同学参赛赢大奖' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '2026 ExampleConsulting Club Member 推荐官计划', text: '加入推荐官计划' }).decision, 'ignore');
});

test('campus recruitment launch and invitation-to-apply mails are ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '示例检索2027届暑期实习招聘投递邀请', text: '示例检索2027届暑期实习招聘已启动，诚邀你投递' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '【示例检索】2027届校招已启动，诚邀你投递！', text: '校招岗位现已开放' }).decision, 'ignore');
});

test('account/system and holiday mails are ignored', () => {
  assert.equal(triageRecruitmentMessage({ subject: '示例咨询中国招聘官网注册邮箱激活码：123456', text: '你的激活码是 123456' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '您好，您的离职交接已完成。', text: '离职交接流程已完成' }).decision, 'ignore');
  assert.equal(triageRecruitmentMessage({ subject: '马跃新程 恭贺新禧! Happy New Year of the Horse', text: '恭贺新禧' }).decision, 'ignore');
});

test('real application confirmation is not over-filtered', () => {
  assert.equal(triageRecruitmentMessage({ subject: '【示例社区招聘】简历投递成功 - 示例候选人 - 示例产品实习生', text: '我们已收到你投递的示例产品实习生职位简历' }).decision, 'analyze');
});

test('personal EXAMPLE_FLIGHT application confirmations override the promotional-looking subject', () => {
  for (const position of ['示例岗位戊', '示例岗位丙']) {
    const result = triageRecruitmentMessage({
      subject: '欢迎投递 EXAMPLE_FLIGHT 示例飞行科技 2027 “探索者” 校园招聘职位',
      sender: 'EXAMPLE_FLIGHT 示例飞行科技招聘 <jobs@example.test>',
      text: `感谢您关注 EXAMPLE_FLIGHT 示例飞行科技并投递 ${position}，您的申请已经提交成功。`,
    });
    assert.equal(result.decision, 'analyze', position);
    assert.equal(result.signal, 'submitted', position);
  }
});

test('a failed submission notice cannot end an otherwise valid application route', () => {
  const result = triageRecruitmentMessage({
    subject: '投递失败2026-09-05 12:09:59',
    sender: '示例交通招聘 <jobs@example.test>',
    text: '本次职位投递失败，请返回招聘网站检查后重新尝试。',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'failed-submission');
});

test('the company name 示例作业科技 does not turn a submission receipt into an assessment', () => {
  const result = triageRecruitmentMessage({
    subject: '感谢你投递示例作业科技教育科技公司的AI产品经理职位',
    text: '我们已收到您的申请。',
  });
  assert.equal(result.decision, 'analyze');
  assert.equal(result.signal, 'submitted');
});

test('interview satisfaction survey is ignored even though subject contains 面试', () => {
  const result = triageRecruitmentMessage({
    subject: '示例旅行科技有限公司面试满意度问卷',
    text: '非常感谢你参加示例旅行科技有限公司的面试。为进一步改善候选人的面试体验，诚邀你花费1分钟填写以下问卷。此问卷仅用于招聘流程优化，不与面试结果关联。',
  });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.signal, 'survey');
});

test('survey with explicit end wording still flows to ended analysis', () => {
  const result = triageRecruitmentMessage({
    subject: '示例网络校园招聘——邀请您填写面试反馈问卷',
    text: '您的面试流程目前已结束，诚邀您填写面试反馈问卷。',
  });
  assert.equal(result.decision, 'analyze');
});

// 退信通知的标题会引用原邮件主题（实测「通知：[撤回邮件失败]回复：来自某公司的
// 面试邀请」），放行去问模型时标题里的流程词会让它被当成面试，而这封邮件正文
// 一句招聘内容都没有。同一个输入模型两次判断还不一致（实测 isJobRelated 一次 0
// 一次 1），所以必须在进模型之前拦掉。
test('a bounce notice quoting an interview subject is ignored as a system mail', () => {
  const result = triageRecruitmentMessage({
    subject: '通知：[撤回邮件失败]回复：来自示例科技的面试邀请',
    text: '您对邮件进行了撤回操作，但是撤回失败。原因：对方邮件地址无效。',
    sender: 'postmaster@163.com',
  });

  assert.equal(result.decision, 'ignore', '退信不该进模型分析，否则标题里的流程词会带偏状态');
  assert.equal(result.signal, 'system');
});

// 配对边界：「投递失败」不能被新的退信规则抢走——它归 FAILED_SUBMISSION，
// 且那封必须留在库里（ignore 但已入库），否则同公司已成功投递的路线会被覆盖。
test('a failed submission keeps its own signal instead of being read as a bounce', () => {
  const result = triageRecruitmentMessage({
    subject: '【示例科技】投递失败',
    text: '职位投递失败，请稍后重试。',
  });

  assert.equal(result.signal, 'failed-submission', '投递失败必须走 FAILED_SUBMISSION 分支，不能落到 system');
});
