#!/usr/bin/env node
// 只读拉取网易邮箱 2026-01-01 ~ 2026-08-20 的全部邮件，按月分批，跨批去重，
// 输出 JSONL（messageId / receivedAt / sender / subject / text / html）到 data/eval/real-mails.jsonl。
// 注意：本脚本需要真实网络（imap.163.com 不在沙箱白名单内），须在关闭沙箱的情况下运行。
// 邮箱仅做只读操作：mailboxOpen 使用 readOnly:true，fetch 走 BODY.PEEK，不设置任何标记。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getMailboxProvider } from '../src/mail/provider-registry.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const SECRETS_DIR = path.join(ROOT, 'data', '.secrets');
const OUT_FILE = path.join(ROOT, 'data', 'eval', 'real-mails.jsonl');

const WINDOWS = [
  ['2026-01-01', '2026-01-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-03-01', '2026-03-31'],
  ['2026-04-01', '2026-04-30'],
  ['2026-05-01', '2026-05-31'],
  ['2026-06-01', '2026-06-30'],
  ['2026-07-01', '2026-07-31'],
  ['2026-08-01', '2026-08-20'],
];

const PROVIDER_ID = 'netease';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 200;
const MAX_TEXT = 4_000;
const MAX_HTML = 300_000;

function dateOnlyStart(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid date ${value}`);
  return date;
}

function dateOnlyEndExclusive(value) {
  return new Date(dateOnlyStart(value).getTime() + DAY_MS);
}

function formatSender(from) {
  const sender = Array.isArray(from) ? from[0] : from;
  if (!sender) return '';
  const address = sender.address || '';
  const name = sender.name || '';
  return name && address ? `${name} <${address}>` : name || address;
}

function buildText(parsed) {
  const links = [...String(parsed.html || '').matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((url, index, urls) => urls.indexOf(url) === index);
  return [
    parsed.text,
    links.length ? `链接：${links.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .replace(/\r\n/g, '\n')
    .slice(0, MAX_TEXT);
}

async function readSecret(fileName) {
  const value = (await readFile(path.join(SECRETS_DIR, fileName), 'utf8')).trim();
  if (!value) throw new Error(`secret file is empty: ${fileName}`);
  return value;
}

function resolveProxy(env = process.env) {
  const raw = String(env.IMAP_PROXY || env.imap_proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '').trim();
  if (!raw) return undefined;
  try { const url = new URL(raw); return url.href; } catch { return undefined; }
}

function connect(profile, email, authorizationCode) {
  const proxy = resolveProxy();
  return new ImapFlow({
    host: profile.host,
    port: profile.port,
    secure: profile.secure,
    auth: { user: email, pass: authorizationCode },
    logger: false,
    ...(proxy ? { proxy } : {}),
    ...(profile.tlsServername ? { tls: { servername: profile.tlsServername } } : {}),
  });
}

async function ensureConnected(client) {
  if (!client.usable) await client.connect();
}

function discardClient(client) {
  void Promise.resolve(client.logout()).catch(() => {
    try { client.close(); } catch { /* already closed */ }
  });
}

async function fetchWindow(client, from, to) {
  await ensureConnected(client);
  await client.mailboxOpen('INBOX', { readOnly: true });
  const uids = await client.search(
    { since: dateOnlyStart(from), before: dateOnlyEndExclusive(to) },
    { uid: true },
  );
  if (!uids.length) return [];
  const slice = uids.slice(0, MAX_MESSAGES_PER_WINDOW);
  const fetched = await client.fetchAll(slice, { envelope: true, source: true }, { uid: true });
  const items = [];
  for (const item of fetched) {
    const parsed = await simpleParser(item.source, { skipHtmlToText: false });
    const date = parsed.date || item.envelope?.date;
    if (!date || !Number.isFinite(new Date(date).getTime())) continue;
    items.push({
      messageId: parsed.messageId || item.envelope?.messageId || '',
      receivedAt: new Date(date).toISOString(),
      sender: formatSender(parsed.from),
      subject: String(parsed.subject || item.envelope?.subject || ''),
      text: buildText(parsed),
      html: typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_HTML) : '',
    });
  }
  return items;
}

function dedupeKey(item) {
  return item.messageId || `${item.receivedAt}|${item.subject}`;
}

async function main() {
  const profile = getMailboxProvider(PROVIDER_ID);
  const email = await readSecret('mailbox-email.txt');
  const authorizationCode = await readSecret('mailbox-netease-auth.txt');

  const seen = new Map();
  const monthStats = [];
  const failedWindows = [];
  let client = connect(profile, email, authorizationCode);

  for (const [from, to] of WINDOWS) {
    try {
      const items = await fetchWindow(client, from, to);
      let fresh = 0;
      for (const item of items) {
        const key = dedupeKey(item);
        if (seen.has(key)) continue;
        seen.set(key, item);
        fresh += 1;
      }
      monthStats.push({ window: `${from}~${to}`, fetched: items.length, kept: fresh });
      console.error(`[${from}~${to}] 拉取 ${items.length} 封，去重后新增 ${fresh} 封`);
    } catch (error) {
      const message = String(error?.message || error);
      failedWindows.push({ window: `${from}~${to}`, reason: message });
      console.error(`[${from}~${to}] 失败，跳过：${message}`);
      discardClient(client);
      client = connect(profile, email, authorizationCode);
    }
  }

  discardClient(client);

  const records = [...seen.values()];
  records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const payload = records.map((item) => `${JSON.stringify(item)}\n`).join('');
  await writeFile(OUT_FILE, payload, 'utf8');

  const summary = {
    provider: PROVIDER_ID,
    range: '2026-01-01 ~ 2026-08-20',
    totalUnique: records.length,
    monthStats,
    failedWindows,
    outFile: path.relative(ROOT, OUT_FILE),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});
