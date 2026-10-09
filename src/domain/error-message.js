// Retain diagnostic wording while removing credentials and identifying values.
const REDACTIONS = [
  // 邮件地址：保留首字符，能看出是邮箱类错误即可
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `${m[0]}***@***`],
  // URL：保留 origin，剥掉 path/query（query 里常有 token/签名）
  [/\bhttps?:\/\/[^\s'"<>)\]]+/g, (m) => {
    try {
      return new URL(m).origin;
    } catch {
      return '[url]';
    }
  }],
  // Bearer / sk- / key 形式的凭据
  [/\b(?:Bearer|Basic)\s+[\w.\-~+/=]{8,}/gi, '[credential]'],
  [/\bsk-[A-Za-z0-9_\-]{8,}/g, '[credential]'],
  // 绝对文件路径：保留最后两段，够定位是哪个模块
  [/(?:\/[\w.\-@+ ]+){2,}\/?/g, (m) => `…/${m.split('/').filter(Boolean).slice(-2).join('/')}`],
  // 长十六进制串（请求 id / hash）
  [/\b[0-9a-f]{16,}\b/gi, '[hex]'],
];

const MAX_MESSAGE_CHARS = 200;

export function redactErrorMessage(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let out = raw;
  for (const [pattern, replace] of REDACTIONS) out = out.replace(pattern, replace);
  return out.slice(0, MAX_MESSAGE_CHARS);
}
