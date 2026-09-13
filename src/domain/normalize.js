// 确定性代码只处理通用格式、时间和链接；公司与岗位语义由模型和用户配置负责。

export function normalizeCompany(company) {
  return String(company || '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

export function inferCompanyFromEvidence({ company = '' } = {}) {
  return normalizeCompany(company);
}

export function normalizePositionName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function deriveStatusFromEvidence({ subject = '', text = '' } = {}) {
  const title = String(subject || '');
  const body = String(text || '');

  if (/简历已进入人才库/i.test(body)) return '已结束';
  if (/测评|笔试|Assessment|Online Test/i.test(title)) return '测评中';
  if (/邀请您?参加.{0,30}(?:线上|在线)?测评|已通过简历评估并进入笔试/i.test(body)) return '测评中';
  if (/Offer|录用通知|正式聘用|薪资方案/i.test(title)) return 'Offer';
  if (/面试邀请|面试安排|Interview Invitation/i.test(title)) return '面试';
  if (/投递成功|成功投递|投递反馈|Successful Application|顺利完成网申|感谢您的职位投递/i.test(title)) return '已投递';

  if (/招聘流程(?:已)?结束|(?:您的|你的|本次)(?:申请|应聘|招聘流程).{0,24}(?:未通过|已结束|不再推进|暂不推进)|很遗憾.{0,30}(?:未通过|不再推进)/i.test(body)) return '已结束';
  if (/邀请您?(?:完成|参加).{0,20}(?:在线)?(?:测评|笔试)|已进入笔试|请在.{0,30}完成.{0,12}(?:测评|笔试)/i.test(body)) return '测评中';
  if (/(?:已经|已)收到.{0,30}(?:申请|简历)|简历已经成功提交|简历已进入复筛/i.test(body)) return '已投递';
  return '';
}

function beijingDateTimeToIso(year, month, day, hour, minute, second = 0) {
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
    Number(second || 0),
  );
  return Number.isFinite(value) ? new Date(value).toISOString() : '';
}

function addCalendarDays(iso, days) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp + Number(days) * 86_400_000).toISOString();
}

function addBusinessDays(iso, days) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const beijingOffsetMs = 8 * 60 * 60 * 1000;
  const result = new Date(timestamp + beijingOffsetMs);
  let remaining = Number(days);
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return new Date(result.getTime() - beijingOffsetMs).toISOString();
}

// 只解析招聘测评邮件中可直接核验的时间表达。中文邮件未标时区时，按产品约定使用北京时间。
// “只有截止时间”统一以收件时间为 eventStart；相对天数按表达本身通用解析。
export function deriveEventWindowFromEvidence({ subject = '', text = '', receivedAt = '' } = {}) {
  const title = String(subject || '');
  const body = String(text || '');
  const corpus = `${title}\n${body}`;
  const receivedIso = Number.isFinite(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : '';

  const datedRange = corpus.match(
    /(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d)[:：]([0-5]\d)(?::([0-5]\d))?\s*(?:～|~|至|--|—|–)\s*(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d)[:：]([0-5]\d)(?::([0-5]\d))?/,
  );
  if (datedRange) {
    return {
      eventStart: beijingDateTimeToIso(...datedRange.slice(1, 7)),
      eventEnd: beijingDateTimeToIso(...datedRange.slice(7, 13)),
    };
  }

  const sameDayRange = corpus.match(
    /(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d)[:：]([0-5]\d)(?::([0-5]\d))?\s*(?:～|~|至|--|—|–)\s*([0-2]?\d)[:：]([0-5]\d)(?::([0-5]\d))?/,
  );
  if (sameDayRange) {
    return {
      eventStart: beijingDateTimeToIso(...sameDayRange.slice(1, 7)),
      eventEnd: beijingDateTimeToIso(
        sameDayRange[1],
        sameDayRange[2],
        sameDayRange[3],
        sameDayRange[7],
        sameDayRange[8],
        sameDayRange[9],
      ),
    };
  }

  const explicit = [...corpus.matchAll(
    /(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d)[:：]([0-5]\d)(?::([0-5]\d))?/g,
  )];
  if (explicit.length === 1 && receivedIso) {
    return {
      eventStart: receivedIso,
      eventEnd: beijingDateTimeToIso(...explicit[0].slice(1, 7)),
    };
  }

  const relativeDays = corpus.match(/(\d{1,2})\s*个?\s*(自然日|工作日)/);
  if (relativeDays && receivedIso) {
    const addDays = relativeDays[2] === '工作日' ? addBusinessDays : addCalendarDays;
    return {
      eventStart: receivedIso,
      eventEnd: addDays(receivedIso, Number(relativeDays[1])),
    };
  }

  return {};
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"');
}

function linkScore(label, href, nearby = '') {
  const context = `${nearby} ${label}`;
  if (/取消订阅|unsubscribe|不参加|拒绝|decline|confirm-no|confirm-yes|参加\s*\/\s*Yes/i.test(`${label} ${href}`)) return -100;
  if (/作答链接|测评链接|笔试链接|实战作业链接|作业链接|作业地址|考试地址|开始测评|开始作答|进入测评|在线测评|online assessment|online test|start assessment/i.test(context)) return 100;
  if (/assessment|exam|test|evaluate|talent/i.test(href)) return 30;
  return 0;
}

export function extractActionLink({ html = '', text = '' } = {}) {
  const source = String(html || '');
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const href = decodeHtmlAttribute(match[1]);
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const nearby = source.slice(Math.max(0, match.index - 100), match.index).replace(/<[^>]+>/g, ' ');
    candidates.push({ href, score: linkScore(label, href, nearby) });
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (best?.score > 0) return best.href;

  const plainText = String(text || '');
  const textCandidates = [...plainText.matchAll(/https?:\/\/[^\s<>]+/gi)].map((match) => {
    const href = decodeHtmlAttribute(match[0]).replace(/[)）>，。]+$/, '');
    const nearby = plainText.slice(Math.max(0, match.index - 100), match.index);
    return { href, score: linkScore('', href, nearby) };
  });
  const bestText = textCandidates.sort((a, b) => b.score - a.score)[0];
  if (bestText?.score > 0) return bestText.href;

  const contextual = plainText.match(/(?:作答链接|测评链接|笔试链接|实战作业链接|作业链接|作业地址|考试地址)\s*[:：]?\s*(https?:\/\/\S+)/i);
  return contextual ? contextual[1].replace(/[)）>，。]+$/, '') : '';
}

function interviewLinkScore(label, href, nearby = '') {
  const context = `${nearby} ${label}`;
  if (/取消订阅|unsubscribe|拒绝|decline|下载|download/i.test(`${label} ${href}`)) return -100;
  if (/面试链接|会议链接|进入面试|参加面试|加入会议|interview link|join (?:the )?meeting/i.test(context)) return 100;
  if (/meeting|interview|zoom\.us|teams\.microsoft|voovmeeting|tencentmeeting/i.test(href)) return 30;
  return 0;
}

export function extractInterviewLink({ html = '', text = '' } = {}) {
  const source = String(html || '');
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const href = decodeHtmlAttribute(match[1]);
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const nearby = source.slice(Math.max(0, match.index - 100), match.index).replace(/<[^>]+>/g, ' ');
    candidates.push({ href, score: interviewLinkScore(label, href, nearby) });
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (best?.score > 0) return best.href;

  const contextual = String(text || '').match(/(?:面试链接|会议链接|进入面试|加入会议)\s*[:：]?\s*(https?:\/\/\S+)/i);
  return contextual ? contextual[1].replace(/[)）>，。]+$/, '') : '';
}
