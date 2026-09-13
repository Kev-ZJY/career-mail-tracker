const URL_PATTERN = /https?:\/\/[^\s；，。！？）)\]}>"']+/i;

function normalizeHttpUrl(value) {
  const match = String(value || '').match(URL_PATTERN);
  if (!match) return '';
  try {
    const url = new URL(match[0]);
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function formatBeijingDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

// 备注是面向用户的结构化补充信息，不承载模型解释、邮件摘录或置信度提示。
export function buildProgressNotes({ status, notes = '', actionLink = '', eventEnd = '' } = {}) {
  if (status === '测评中') {
    const link = normalizeHttpUrl(actionLink) || normalizeHttpUrl(notes);
    const deadline = formatBeijingDateTime(eventEnd);
    return [
      link ? `测评链接：${link}` : '',
      deadline ? `测评截止时间：${deadline}` : '',
    ].filter(Boolean).join('；');
  }

  if (status === '面试') {
    const link = normalizeHttpUrl(actionLink) || normalizeHttpUrl(notes);
    return link ? `面试链接：${link}` : '';
  }

  return '';
}
