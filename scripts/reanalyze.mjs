#!/usr/bin/env node
// 存量邮件离线重分析。
//
// 用途：ANALYSIS_VERSION 或默认模型变更后，把库里已存在的邮件按新提示词/新模型
// 重跑一遍并回填，使日常同步只处理新增邮件（否则每次同步都会全量重跑）。
//
// 为什么不放在同步路径里：存量重跑是 N×网络往返的批量作业（实测数百封 → 数分钟），
// 同步按钮不该承担这个；而且它改的是历史数据，必须由人显式触发。
//
// 用法：
//   node scripts/reanalyze.mjs --dry-run          只列出待重分析清单，不调模型、不写库
//   node scripts/reanalyze.mjs --apply            真正执行
//   node scripts/reanalyze.mjs --apply --limit 20 先跑 20 封验证结果
//   node scripts/reanalyze.mjs --apply --concurrency 6
//
// 身份契约：每行都带上库内的 messageKey，让 sync-service 信任库内已有的身份
// （content_hash / 主键），而不是用截断后的 body_text 重算。详见 test/sync-replay.test.js。
import { resolve } from 'node:path';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createConfig } from '../src/config.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { createSyncService } from '../src/services/sync-service.js';
import { createLlmClassifier } from '../src/services/llm-service.js';
import { bootstrapCredentials } from '../src/services/credential-bootstrap.js';
import { loadLocalRules } from '../src/rules-config.js';

function parseArgs(argv) {
  const positional = [];
  const options = { apply: false, limit: null, concurrency: null };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') continue;
    else if (arg === '--limit') options.next = 'limit';
    else if (arg === '--concurrency') options.next = 'concurrency';
    else if (options.next === 'limit') {
      options.limit = Number.parseInt(arg, 10);
      options.next = null;
    } else if (options.next === 'concurrency') {
      options.concurrency = Number.parseInt(arg, 10);
      options.next = null;
    } else positional.push(arg);
  }
  return { positional, options };
}

const { positional, options } = parseArgs(process.argv.slice(2));
// 不带 --apply 时一律按预演处理：改历史数据必须是显式动作。
const dryRun = !options.apply;

const config = createConfig();
const databasePath = positional[0] || resolve(config.dataDir, 'tracker.sqlite');
const opened = createDatabase(databasePath);
const database = opened.db;
const repository = createMessageRepository(database);
const credentialStore = createCredentialStore();
const settingsService = createSettingsService({ repository, credentialStore });

const targetVersion = config.analysisVersion;
const rows = database.prepare(`
  SELECT id, message_key AS messageKey, message_id AS messageId, account_id AS accountId,
    provider, folder, received_at AS receivedAt, sender, subject,
    body_text AS bodyText, body_html AS bodyHtml, analysis_version AS analysisVersion,
    company, position, status, is_job_related AS isJobRelated
  FROM mail_messages
  WHERE source != 'manual'
    AND body_text IS NOT NULL AND body_text != ''
    AND analysis_version IS NOT ?
  ORDER BY received_at ASC, id ASC
`).all(targetVersion);

const report = {
  databasePath,
  mode: dryRun ? 'dry-run' : 'apply',
  targetAnalysisVersion: targetVersion,
  concurrency: options.concurrency ?? undefined,
  totalPending: rows.length,
  accounts: [...new Set(rows.map((row) => row.accountId))],
  missingBody: database.prepare(`
    SELECT COUNT(*) AS count FROM mail_messages
    WHERE source != 'manual' AND (body_text IS NULL OR body_text = '')
  `).get().count,
  pendingByVersion: Object.fromEntries(
    database.prepare(`
      SELECT analysis_version AS version, COUNT(*) AS count FROM mail_messages
      WHERE source != 'manual' AND analysis_version IS NOT ?
      GROUP BY 1 ORDER BY count DESC
    `).all(targetVersion).map((row) => [row.version, row.count]),
  ),
  applied: false,
  analyzed: 0,
  failed: 0,
  failures: [],
  changes: [],
};

if (dryRun) {
  report.sample = rows.slice(0, 10).map((row) => ({
    id: row.id,
    receivedAt: row.receivedAt,
    subject: String(row.subject || '').slice(0, 60),
    currentVersion: row.analysisVersion,
    current: `${row.company || '(空)'} / ${row.position || '(空)'} / ${row.status}`,
  }));
  console.log(JSON.stringify(report, null, 2));
  opened.close();
  process.exit(0);
}

const targets = options.limit ? rows.slice(0, options.limit) : rows;
const before = new Map(rows.map((row) => [row.messageKey, row]));

await bootstrapCredentials({
  repository,
  credentialStore,
  secretsDir: resolve(config.dataDir, '.secrets'),
});
const model = settingsService.getActiveModel();
if (!model.credentialRef && model.id !== 'ollama') {
  console.error(`模型 ${model.id} 未配置凭据，无法重分析。先在设置里填 API Key。`);
  opened.close();
  process.exit(1);
}
const rules = await loadLocalRules(resolve(config.rulesFile));
const classifier = createLlmClassifier({ provider: model, credentialStore, rules });
const service = createSyncService({
  repository,
  classifier,
  analysisVersion: targetVersion,
  ...(options.concurrency ? { concurrency: options.concurrency } : {}),
});

console.error(`重分析 ${targets.length} 封（版本 → ${targetVersion}，模型 ${model.model}）…`);

const byAccount = new Map();
for (const row of targets) {
  if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, []);
  byAccount.get(row.accountId).push(row);
}

for (const [accountId, accountRows] of byAccount) {
  const first = accountRows[0];
  const last = accountRows[accountRows.length - 1];
  const summary = await service.syncMessages({
    accountId,
    from: new Date(Date.parse(first.receivedAt) - 86_400_000).toISOString(),
    to: new Date(Date.parse(last.receivedAt) + 86_400_000).toISOString(),
    messages: accountRows.map((row) => ({
      // 关键：带上库内主键，sync-service 会信任库内身份而不重算 content_hash。
      messageKey: row.messageKey,
      messageId: row.messageId,
      provider: row.provider,
      folder: row.folder,
      receivedAt: row.receivedAt,
      sender: row.sender,
      subject: row.subject,
      text: row.bodyText,
      html: row.bodyHtml || '',
    })),
    source: 'reanalyze',
  });
  report.analyzed += summary.analyzed;
  report.failed += summary.modelFailed;
  report.failures.push(...summary.failures);
  for (const result of summary.results) {
    const old = before.get(result.messageKey);
    if (!old) continue;
    const changed = old.company !== result.company
      || old.position !== result.position
      || old.status !== result.status
      || Boolean(old.isJobRelated) !== Boolean(result.isJobRelated);
    if (changed) {
      report.changes.push({
        receivedAt: result.receivedAt,
        subject: String(result.subject || '').slice(0, 60),
        before: `${old.company || '(空)'} / ${old.position || '(空)'} / ${old.status} / ${old.isJobRelated ? '求职相关' : '非求职'}`,
        after: `${result.company || '(空)'} / ${result.position || '(空)'} / ${result.status} / ${result.isJobRelated ? '求职相关' : '非求职'}`,
      });
    }
  }
  console.error(`  ${accountId}: 分析 ${summary.analyzed} 封，失败 ${summary.modelFailed} 封`);
}

report.applied = true;
report.changedCount = report.changes.length;
console.log(JSON.stringify(report, null, 2));
opened.close();
