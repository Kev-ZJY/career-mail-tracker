import { getMailboxProvider } from '../mail/provider-registry.js';
import { convert as htmlToText } from 'html-to-text';
import { DEFAULT_TIMEOUTS, withDeadline } from './deadline.js';
import { buildImapOptions, createImapClient } from './imap-connection.js';
import { imapReceiptScope } from './imap-receipts.js';

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

// 超长正文（如内嵌 200KB 图片 base64 的邮件）截断时：
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

export function createImapSource({
  providerRegistry = getMailboxProvider,
  clientFactory = createImapClient,
  parser = defaultParser,
  repository,
  analysisVersion,
  env = typeof process !== 'undefined' ? process.env : {},
  timeouts: timeoutOverrides = {},
} = {}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...timeoutOverrides };
  return {
    async fetchMessages({ accountId, provider, email, authorizationCode, from, to, maxMessages, dryRun = false, signal, onSelection = () => {}, onProgress = () => {} }) {
      const step = (operation, key, code, label) => withDeadline(operation, { timeoutMs: timeouts[key], signal, code, label });
      const profile = providerRegistry(provider);
      const options = buildImapOptions(profile, { email, authorizationCode }, { env, timeouts });
      // 时区安全垫：IMAP SEARCH 的 SINCE/BEFORE 按 UTC 日界取整，而业务窗口按北京时间
      // 定义。前后各扩 1 天保证 0-8 点收到的邮件不落在搜索窗口外；精确过滤由
      // sync-service 的 inRange（时间戳级）兜底，不会多入库。
      const since = new Date(dateOnlyStart(from).getTime() - DAY_MS);
      const before = new Date(dateOnlyEndExclusive(to).getTime() + DAY_MS);
      if (since >= before) throw new Error('from must be earlier than or equal to to');

      onProgress({ stage: 'connecting', label: '邮箱连接中' });
      const client = await step(() => clientFactory(options), 'connectMs', 'IMAP_CONNECT_TIMEOUT', '创建邮箱连接');
      // ImapFlow 在连接已异常关闭、调用方已经捕获 fetch 错误之后，仍可能异步再发出
      // 一个 `error` 事件。EventEmitter 若无人监听会直接终止整个本地服务进程。
      // 保留实例级监听器承接该尾随事件；主流程错误仍由下方 await 正常抛给 API。
      client.on?.('error', () => {});
      const close = () => { try { client.close?.(); } catch { /* already closed */ } };
      signal?.addEventListener('abort', close, { once: true });
      let lock;
      try {
        await step(() => client.connect(), 'connectMs', 'IMAP_CONNECT_TIMEOUT', '邮箱连接');
        onProgress({ stage: 'opening', label: '打开收件箱中' });
        lock = await step(() => client.getMailboxLock('INBOX', { readOnly: true }), 'lockMs', 'IMAP_LOCK_TIMEOUT', '打开收件箱');
        onProgress({ stage: 'searching', label: '搜索日期窗口内邮件' });
        const uids = await step(() => client.search({ since, before }, { uid: true }), 'searchMs', 'IMAP_SEARCH_TIMEOUT', '搜索邮件');
        const uidValidity = String(client.mailbox?.uidValidity || 'unknown');
        const scope = imapReceiptScope({ accountId, provider: profile.id, email, folder: 'INBOX', uidValidity, analysisVersion });
        // SEARCH remains over the complete requested window. Completed UIDs are
        // removed before fetching source bodies; newly discovered UIDs (even old
        // received dates or reused Message-IDs) still take the normal path.
        // Dry runs preserve their original full-window prescreen semantics.
        const completedUids = !dryRun && scope ? repository?.getCompletedImapUids?.(scope, { from, to }) || new Set() : new Set();
        const unread = uids.filter((uid) => !completedUids.has(String(uid)));
        const selected = maxMessages == null ? unread : unread.slice(-Math.max(1, Number(maxMessages) || 1));
        const sourceStats = {
          sourceSearched: uids.length,
          sourceCached: uids.length - unread.length,
          sourceFetched: 0,
          sourceDeferred: unread.length - selected.length,
        };
        const report = (event) => { onSelection({ ...sourceStats }); onProgress({ ...event, ...sourceStats }); };
        if (!selected.length) {
          report({ stage: 'fetching', label: '日期窗口检查完成，无需读取正文', completed: 0, total: 0 });
          return [];
        }
        const query = { envelope: true, source: true };
        // Use the production client's iterator so the first read/progress update
        // does not wait for every body. fetchAll remains a legacy adapter fallback.
        const fetched = typeof client.fetch === 'function'
          ? client.fetch(selected, query, { uid: true })
          : await step(() => client.fetchAll(selected, query, { uid: true }), 'fetchMs', 'IMAP_FETCH_TIMEOUT', '读取邮件');
        const iterator = fetched[Symbol.asyncIterator]?.() || fetched[Symbol.iterator]();
        const normalized = [];
        let completed = 0;
        report({ stage: 'fetching', label: '新增或待重试邮件读取中', completed, total: selected.length });
        while (true) {
          const next = await step(() => iterator.next(), 'fetchMs', 'IMAP_FETCH_TIMEOUT', '读取下一封邮件');
          if (next.done) break;
          const item = next.value;
          sourceStats.sourceFetched += 1;
          report({ stage: 'parsing', label: '邮件正文解析中', completed, total: selected.length });
          const parsed = await step(() => parser(item.source), 'parseMs', 'MAIL_PARSE_TIMEOUT', '解析邮件正文');
          completed += 1;
          report({ stage: 'fetching', label: '新增或待重试邮件读取中', completed, total: selected.length });
          const date = parsed.date || item.envelope?.date;
          if (!date || !Number.isFinite(new Date(date).getTime())) continue;
          const htmlLinks = extractHtmlLinks(parsed.html);
          const bodyText = typeof parsed.html === 'string' && parsed.html
            ? htmlToPlainText(parsed.html)
            : (typeof parsed.text === 'string' ? parsed.text : '');
          const text = [
            bodyText,
            htmlLinks.length ? `链接：${htmlLinks.join('\n')}` : '',
          ].filter(Boolean).join('\n');
          normalized.push({
            provider: profile.id,
            mailboxEmail: email.trim().toLowerCase(),
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
        // A disappearing UID or invalid mail date is not a successful receipt.
        // Hold the watermark and retry these UIDs on the next window scan.
        sourceStats.sourceDeferred += Math.max(0, selected.length - normalized.length);
        report({ stage: 'fetching', label: '邮件读取完成', completed, total: selected.length });
        return normalized;
      } catch (error) {
        close();
        throw error;
      } finally {
        signal?.removeEventListener('abort', close);
        try { lock?.release(); } catch { /* lock already released */ }
        if (typeof client.logout === 'function') {
          try {
            await withDeadline(() => client.logout(), { timeoutMs: timeouts.logoutMs, code: 'IMAP_LOGOUT_TIMEOUT', label: '退出邮箱连接' });
          } catch { close(); }
        }
      }
    },
  };
}
