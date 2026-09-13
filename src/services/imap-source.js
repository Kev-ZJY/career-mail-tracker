import { getMailboxProvider } from '../mail/provider-registry.js';
import { convert as htmlToText } from 'html-to-text';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ANALYSIS_TEXT = 24_000;

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value.trim();
}

function dateOnlyStart(value) {
  const text = requiredText(value, 'date');
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('date is invalid');
  return date;
}

function dateOnlyEndExclusive(value) {
  const date = dateOnlyStart(value);
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return new Date(dayStart.getTime() + DAY_MS);
}

function formatSender(from = []) {
  const candidates = Array.isArray(from)
    ? from
    : Array.isArray(from?.value)
      ? from.value
      : [from];
  const sender = candidates.find((candidate) => candidate?.address || candidate?.name);
  if (!sender) return '';
  const address = sender.address || '';
  const name = sender.name || '';
  return name && address ? `${name} <${address}>` : name || address;
}

// 超长正文（如内嵌 200KB 图片 base64 的爱奇艺邮件）截断时：
// 只留头尾会丢掉正文中后段的职位名，这里按「头 10K + 职位锚词行 8K + 尾 6K」保留，
// 保证投递确认（职位在头）、面试/测评（职位在中后段）、超长模板（职位在尾部）都能被模型看到。
function clampText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n');
  if (text.length <= MAX_ANALYSIS_TEXT) return text;
  const ANCHOR_RE = /职位|岗位|应聘|任职|面试|申请|offer|position|role/i;
  const head = text.slice(0, 10_000);
  const tail = text.slice(-6_000);
  const anchors = text.split('\n').filter((line) => ANCHOR_RE.test(line)).join('\n').slice(0, 8_000);
  return [head, anchors, tail].join('\n').slice(0, MAX_ANALYSIS_TEXT);
}

function extractHtmlLinks(value) {
  return [...String(value || '').matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

async function defaultClientFactory(options) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow(options);
}

async function defaultParser(source) {
  const { simpleParser } = await import('mailparser');
  return simpleParser(source, { skipHtmlToText: false });
}

// mailparser 内置的 html→text 转换（默认配置）可能丢失不可编辑节点中的可见正文。
// 这里使用通用 HTML 转换保证正文完整；不识别任何公司或邮件模板。
function htmlToPlainText(html) {
  if (typeof html !== 'string' || !html) return '';
  // 极端大 HTML（如内嵌 200KB 图片 base64）截断到 500KB 再转，防解析卡死
  const source = html.length > 500_000 ? html.slice(0, 500_000) : html;
  const text = htmlToText(source, {
    wordwrap: false,
    ignoreHref: true,
    ignoreImage: true,
    uppercaseHeadings: false,
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'head', format: 'skip' },
    ],
  });
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// mailparser 的 html-to-text 可能丢弃 contenteditable="false" span 的文本；
// 一些招聘系统会把正文关键信息放在这类不可编辑节点中，因此通用恢复可见文本。
function recoverHiddenText(parsed) {
  const base = typeof parsed.text === 'string' ? parsed.text : '';
  if (typeof parsed.html !== 'string' || !parsed.html) return base;
  const recovered = [];
  const lockedElementPattern = /<([a-z][\w:-]*)\b[^>]*\bcontenteditable\s*=\s*(?:"false"|'false'|false)[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of parsed.html.matchAll(lockedElementPattern)) {
    const value = htmlToPlainText(match[2]).trim().slice(0, 200);
    if (value) recovered.push(value);
  }
  const additions = [...new Set(recovered)].filter((value) => !base.includes(value));
  return additions.length ? [base, ...additions].join('\n') : base;
}

function resolveProxy(env = typeof process !== 'undefined' ? process.env : {}) {
  // 复用系统代理环境变量，以最小改动穿透本地网关对 163 段的过滤；ImapFlow 原生支持 http/https/socks 的 CONNECT 透传
  const raw = String(
    env.IMAP_PROXY || env.imap_proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '',
  ).trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(url.protocol)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function createImapSource({
  providerRegistry = getMailboxProvider,
  clientFactory = defaultClientFactory,
  parser = defaultParser,
  env = typeof process !== 'undefined' ? process.env : {},
} = {}) {
  return {
    async fetchMessages({ provider, email, authorizationCode, from, to, maxMessages }) {
      const profile = providerRegistry(provider);
      const user = requiredText(email, 'email');
      const pass = requiredText(authorizationCode, 'authorizationCode');
      // 时区安全垫：IMAP SEARCH 的 SINCE/BEFORE 按 UTC 日界取整，而业务窗口按北京时间
      // 定义。前后各扩 1 天保证 0-8 点收到的邮件不落在搜索窗口外；精确过滤由
      // sync-service 的 inRange（时间戳级）兜底，不会多入库。
      const since = new Date(dateOnlyStart(from).getTime() - DAY_MS);
      const before = new Date(dateOnlyEndExclusive(to).getTime() + DAY_MS);
      if (since >= before) throw new Error('from must be earlier than or equal to to');

      const proxy = resolveProxy(env);
      const client = await clientFactory({
        host: profile.host,
        port: profile.port,
        secure: profile.secure,
        auth: { user, pass },
        logger: false,
        ...(proxy ? { proxy } : {}),
        ...(profile.tlsServername && profile.tlsServername !== profile.host ? { tls: { servername: profile.tlsServername } } : {}),
      });
      // ImapFlow 在连接已异常关闭、调用方已经捕获 fetch 错误之后，仍可能异步再发出
      // 一个 `error` 事件。EventEmitter 若无人监听会直接终止整个本地服务进程。
      // 保留实例级监听器承接该尾随事件；主流程错误仍由下方 await 正常抛给 API。
      client.on?.('error', () => {});
      let lock;
      try {
        await client.connect();
        lock = await client.getMailboxLock('INBOX');
        const uids = await client.search({ since, before }, { uid: true });
        if (!uids.length) return [];
        // 默认全量拉取（IMAP 协议无数量上限）。仅当调用方显式传 maxMessages 时截断，
        // 且从 UID 降序取最新的 N 封——绝不能丢最新邮件。
        const fetched = await client.fetchAll(
          maxMessages == null ? uids : uids.slice(-Math.max(1, Number(maxMessages) || 1)),
          { envelope: true, source: true },
          { uid: true },
        );
        const uidValidity = String(client.mailbox?.uidValidity || 'unknown');
        const normalized = [];
        for (const item of fetched) {
          const parsed = await parser(item.source);
          const date = parsed.date || item.envelope?.date;
          if (!date || !Number.isFinite(new Date(date).getTime())) continue;
          const htmlLinks = extractHtmlLinks(parsed.html);
          const bodyText = typeof parsed.html === 'string' && parsed.html
            ? htmlToPlainText(parsed.html)
            : recoverHiddenText(parsed);
          const text = [
            bodyText,
            htmlLinks.length ? `链接：${htmlLinks.join('\n')}` : '',
          ].filter(Boolean).join('\n');
          normalized.push({
            provider: profile.id,
            folder: 'INBOX',
            uidValidity,
            uid: String(item.uid),
            messageId: parsed.messageId || item.envelope?.messageId || '',
            receivedAt: new Date(date).toISOString(),
            sender: formatSender(parsed.from) || formatSender(item.envelope?.from),
            subject: String(parsed.subject || item.envelope?.subject || ''),
            text: clampText(text),
            html: typeof parsed.html === 'string' ? parsed.html : '',
            webUrl: profile.webUrl,
          });
        }
        return normalized;
      } finally {
        try { lock?.release(); } catch { /* lock already released */ }
        if (typeof client.logout === 'function') {
          try { await client.logout(); } catch { /* connection already closed */ }
        }
      }
    },
  };
}
