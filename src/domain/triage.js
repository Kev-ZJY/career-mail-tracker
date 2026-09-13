const ANNOUNCEMENT_RULES = [
  { signal: 'activity', pattern: /招聘活动|招聘会|宣讲会|双选会|招聘预告|招聘公告|校园招聘活动|空中宣讲|人才交流会|招聘峰会|挑战赛|精英挑战|星推官|推荐官|校园大使|训练营|公开课|比赛|竞赛|workshop|分享会|直播预告|空宣/i },
  { signal: 'recommendation', pattern: /岗位推荐|职位推荐|推荐岗位|推荐职位|热门岗位|热招岗位|职位订阅|岗位订阅|职位提醒|职位快讯|为你推荐|职位匹配|智联推荐/i },
  { signal: 'promotion', pattern: /开放投递|开放报名|欢迎投递|招募中|申请攻略|求职攻略|招聘资讯|校招.*开放|培训生.*开放|机会.*攻略|投递邀请|招聘.*启动|校招.*启动|秋招.*启动|春招.*启动|诚邀.*投递|邀请.*投递|开启.*申请|诚邀你投递/i },
  { signal: 'system', pattern: /激活码|验证码|离职交接|注册邮箱|账号激活|登录确认|邮箱激活|密码重置/i },
  { signal: 'greeting', pattern: /恭贺|贺禧|恭祝|新春快乐|新年快乐|happy new year|新禧/i },
];

const PROGRESS_RULES = [
  { signal: 'ended', pattern: /招聘流程.*结束|流程已结束|流程结束|岗位已关闭|职位已关闭|职位关闭|申请已结束|面试反馈问卷|招聘反馈问卷|流程反馈问卷|拒绝|未通过|很遗憾|遗憾地|暂不考虑|暂不推进|不再推进|rejection|unfortunately|regret|decline|decided not to proceed|not been successful|following up on your.*application|update.*application|已结束/i },
  { signal: 'assessment', pattern: /测评|测评链接|在线测评|笔试|(?:在线)?作业(?:通知|任务|提交|截止)|coding\s*test|assessment|网申环节/i },
  { signal: 'offer', pattern: /offer|录用通知|正式聘用|薪资方案|入职意向|恭喜.*录用/i },
  { signal: 'interview', pattern: /面试邀请|面试安排|面试通知|预约面试|技术面|电话面|面试链接|群面|一面|二面|三面|终面|初面|复试|interview|onsite/i },
  { signal: 'submitted', pattern: /投递成功|申请已提交|收到.*申请|感谢.*申请|感谢投递|thanks for.*application|thank you for applying|顺利完成网申|完成网申|网申.*完成|申请已提交|申请编号|应聘.*岗位|简历.*收到|申请进展|申请结果/i },
];

const GENERIC_JOB_WORDS = /招聘|应聘|offer|投递|申请|候选人|简历|面试|测评|笔试|录用|筛选|recruit|application|candidate|hiring/i;
const PERSONAL_CONTEXT = /你|您|本人|候选人|申请|应聘|投递|简历|面试|测评|offer|your application|applicant|候选/i;
const FAILED_SUBMISSION = /(?:职位)?投递失败|申请提交失败|未能提交(?:申请|简历)/i;
const PERSONAL_SUBMISSION_CONFIRMATION = /(?:感谢.{0,50}(?:并|已)?投递\s*[^，。\n]{2,100}|(?:已经|已)收到.{0,24}(?:申请|简历)|(?:申请|投递)(?:已经|已)?提交成功|投递成功|成功投递)/i;

// 满意度调研/面试体验等体验调查类邮件：只有明确说明上一轮流程招聘已结束（结束信号）
// 才作为进度邮件保留；否则是信息性邮件，若进入列表会把进行中的申请错误标成「已结束」。
// 注意：不含「面试反馈问卷/反馈问卷」——那类通常是招聘方随流程终止发出，走 ended 规则保留。
const SURVEY_WORDS = /满意度调研|满意度调查|面试体验|体验调研|满意度问卷|体验调查|调研问卷|调查问卷|面试问卷/i;
const SURVEY_ENDED_SIGNAL = /流程(已结束|终止|已终止|结束)|招聘流程(已结束|终止|结束)|已结束|未通过|不再推进|暂不推进|不匹配|拒绝|很遗憾|感谢你的关注|感谢您的关注|rejection|not been successful|regret|decline/i;

function matchedRule(rules, text) {
  return rules.find((rule) => rule.pattern.test(text));
}

export function triageRecruitmentMessage({ subject = '', text = '', sender = '' } = {}) {
  const header = `${subject}\n${sender}`.trim();
  const combined = `${subject}\n${sender}\n${text}`.trim();
  // 活动/系统/祝福/推荐/宣传类特征词几乎都在主题行；若用正文检测，邮件模板尾部
  // 常见的「关注更多招聘活动」「了解更多宣讲会」会误伤真实投递确认。
  // 进度信号（投递/测评/面试/结束）仍需全文检测。
  const announcement = matchedRule(ANNOUNCEMENT_RULES, header);
  const progress = matchedRule(PROGRESS_RULES, combined);

  // 投递接口失败是一次技术失败，不代表招聘流程终止；若写入进度会把同公司
  // 已成功投递的路线错误覆盖成「已结束」。
  if (FAILED_SUBMISSION.test(combined)) {
    return { decision: 'ignore', reason: '投递提交失败，不作为招聘流程状态', signal: 'failed-submission' };
  }

  // 部分 ATS 用「欢迎投递」作为个人投递成功邮件主题。
  // 正文明确使用完成时确认已收到/已提交时，个人进度证据优先于宣传主题。
  if (PERSONAL_SUBMISSION_CONFIRMATION.test(combined)) {
    return { decision: 'analyze', reason: '检测到个人投递成功确认', signal: 'submitted' };
  }

  // 活动/系统/祝福/宣传/推荐（subject 命中）是强忽略信号：
  // 用户已经投递的申请不会再收到「诚邀投递/校招启动/挑战赛」类主题，
  // 正文模板里的面试/结束词不应把宣传邮件拉回分析。
  if (announcement) {
    return {
      decision: 'ignore',
      reason: announcement.signal === 'recommendation' ? '岗位推荐类邮件' : announcement.signal === 'promotion' ? '招聘宣传或投递广告' : announcement.signal === 'system' ? '账号/系统类邮件' : announcement.signal === 'greeting' ? '节日祝福类邮件' : '招聘活动、比赛或宣讲会通知',
      signal: announcement.signal,
    };
  }

  // 调研/问卷类必须在进度信号之前判断：否则「面试满意度问卷」这类 subject 含
  // 「面试」的邮件会先被 interview 规则拦走，问卷永远漏不进调研分支
  if (SURVEY_WORDS.test(header)) {
    if (SURVEY_ENDED_SIGNAL.test(combined)) {
      return { decision: 'analyze', reason: '调研问卷附带流程结束信号', signal: 'ended' };
    }
    return { decision: 'ignore', reason: '满意度调研/体验调查未说明流程结束，不入招聘列表', signal: 'survey' };
  }

  if (progress) {
    return {
      decision: 'analyze',
      reason: '检测到个人招聘进度信号',
      signal: progress.signal,
    };
  }

  if (GENERIC_JOB_WORDS.test(combined) && PERSONAL_CONTEXT.test(combined) && !announcement) {
    return { decision: 'analyze', reason: '检测到疑似个人招聘上下文', signal: 'generic' };
  }

  return { decision: 'ignore', reason: '未检测到个人招聘进度信号', signal: 'none' };
}
