// 确定性归一与兜底抽取：免费模型结果抖动时，用稳定规则覆盖高置信场景。
// 规则只做「有把握」的事，拿不准一律不动（返回原值），宁可让模型兜底。

const COMPANY_ALIASES = [
  { pattern: /快手科技/, name: '快手' },
  { pattern: /深圳虾皮/, name: 'Shopee' },
  { pattern: /虾皮/, name: 'Shopee' },
  { pattern: /趣拿软件/, name: '北京趣拿软件科技有限公司' },
];

export function normalizeCompany(company) {
  const value = String(company || '').trim();
  if (!value) return value;
  for (const alias of COMPANY_ALIASES) {
    if (alias.pattern.test(value)) return alias.name;
  }
  return value;
}

// 从 subject 高置信抽取职位。只在模型输出 position 为空时兜底。
// 模式 1（小红书系）：【小红书招聘】简历投递成功 - 张三 - 视频用户产品实习生
// 模式 2（九号/部分公司）：感谢你投递…公司的<职位>职位
export function extractPositionFromSubject(subject = '') {
  const text = String(subject).trim();
  if (!text) return '';

  const xhs = text.match(/简历投递成功\s*-\s*([^-]{1,8})\s*-\s*(.+)$/i);
  if (xhs) return cleanPosition(xhs[2]);

  const applied = text.match(/(?:投递|应聘|申请)(?:了)?[^-，。]{0,24}?(?:的|了)\s*([^，。]{2,40}?)\s*(?:岗位|职位|position|role)/i);
  if (applied) return cleanPosition(applied[1]);

  return '';
}

// 从正文高置信抽取职位（模型抽空时兜底）。覆盖：
// 面试岗位：【CN IT-DIGITAL&RETAIL】；for the position of X；for the role of X
export function extractPositionFromText(text = '') {
  const body = String(text || '').trim();
  if (!body) return '';

  const interviewSlot = body.match(/面试岗位\s*[:：]?\s*【([^】]{1,40})】/);
  if (interviewSlot) return cleanPosition(interviewSlot[1]);

  const engPosition = body.match(/(?:for the position of|for the role of|position of the)\s+([A-Za-z(][^.,\n]{4,90}?)(?:\.|,|\n|$)/i);
  if (engPosition) return cleanPosition(engPosition[1]);

  const zhSlot = body.match(/(?:面试岗位|应聘岗位|申请岗位|岗位名称)\s*[:：]\s*([^\n【】]{2,40})/);
  if (zhSlot) return cleanPosition(zhSlot[1]);

  return '';
}

function cleanPosition(value) {
  return String(value || '')
    .replace(/[。．.!！,，；;]+$/, '')
    // DeepSeek 等会把 subject/正文里「…岗位」的岗位尾缀抄进职位（如「ASP - AI Star Program 产品经理培训生岗位」）
    .replace(/岗位$/, '')
    // 【实习】被模型截成「实习】」残缺前缀（如「实习】产品经理-AI方向」）
    .replace(/^实习】/, '')
    .trim()
    .slice(0, 80);
}
