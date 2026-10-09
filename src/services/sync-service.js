import { createHash } from 'node:crypto';
import { triageRecruitmentMessage } from '../domain/triage.js';
import { resolveThreadPlacement } from '../domain/thread-resolver.js';
import {
  deriveEventWindowFromEvidence,
  deriveStatusFromEvidence,
  extractActionLink,
  extractInterviewLink,
  normalizeCompany,
  normalizePositionName,
} from '../domain/normalize.js';
import { buildProgressNotes } from '../domain/progress-notes.js';
import { resolveCompanyName } from '../domain/company-resolver.js';
import { redactErrorMessage } from '../domain/error-message.js';
import { mapInOrder, resolveConcurrency } from './concurrency.js';
import { DEFAULT_TIMEOUTS, withDeadline } from './deadline.js';
import { imapReceiptIdentity } from './imap-receipts.js';

const NEXT_ACTION_BY_STATUS = {
  已投递: '等待后续通知',
  测评中: '完成测评',
  面试: '准备并参加面试',
  Offer: '确认录用安排',
  已结束: '归档该申请',
};
const MAX_CLASSIFY_ATTEMPTS = 3;
// Timeouts and exhausted truncation budgets are handled once per email.
const NON_RETRYABLE_ERROR_CODES = new Set([
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_TRUNCATED',
]);
// Account / endpoint failures stop new requests; in-flight successes are retained.
const RUN_ABORTING_ERROR_CODES = new Set([
  'MODEL_RATE_LIMITED', 'MODEL_NOT_FOUND', 'MODEL_AUTH_FAILED',
  'MODEL_ACCESS_DENIED', 'MODEL_PAYMENT_REQUIRED', 'MODEL_CONFIG_INVALID',
]);

function actualMailboxEmail(accountId, message, mailboxEmail) {
  const supplied = message.mailboxEmail || mailboxEmail;
  // Direct callers historically used their email as accountId. An arbitrary
  // logical alias is not evidence of the physical mailbox's address.
  const address = supplied || (/^[^@\s]+@[^@\s]+$/.test(accountId) ? accountId : '');
  return String(address).trim().toLowerCase();
}

function buildMessageKey(accountId, message, mailboxEmail) {
  if (message.messageId) return `${accountId}|message-id|${message.messageId}`;
  return `${accountId}|imap|${buildImapIdentityKey(accountId, message, mailboxEmail)}`;
}

function buildLegacyImapIdentityKey(accountId, message) {
  return [
    accountId,
    message.folder || 'INBOX',
    message.uidValidity || 'unknown',
    message.uid || message.receivedAt,
  ].join('|');
}

function buildImapIdentityKey(accountId, message, mailboxEmail) {
  return [
    accountId,
    message.provider || 'unknown',
    actualMailboxEmail(accountId, message, mailboxEmail),
    message.folder || 'INBOX',
    message.uidValidity || 'unknown',
    message.uid || message.receivedAt,
  ].join('|');
}

function contentHash(message) {
  return createHash('sha256')
    .update(`${message.subject || ''}\n${message.text || ''}`)
    .digest('hex');
}

function inRange(receivedAt, from, to) {
  const timestamp = Date.parse(receivedAt);
  const fromTimestamp = Date.parse(from);
  const toTimestamp = Date.parse(to);
  return Number.isFinite(timestamp)
    && Number.isFinite(fromTimestamp)
    && Number.isFinite(toTimestamp)
    && timestamp >= fromTimestamp
    && timestamp <= toTimestamp;
}

function recordSyncRun({ repository, accountId, from, to, source, summary }) {
  repository.recordSyncRun({
    accountId,
    from,
    to,
    source,
    inserted: summary.inserted,
    analyzed: summary.analyzed,
    skipped: summary.skipped,
    candidates: summary.candidates,
    ignored: summary.ignored,
    modelFailed: summary.modelFailed,
    failures: summary.failures,
    total: summary.total,
    processed: summary.processed,
    remaining: summary.remaining,
    stopReason: summary.stopReason,
    retryFrom: summary.retryFrom,
    sourceSearched: summary.sourceSearched,
    sourceCached: summary.sourceCached,
    sourceFetched: summary.sourceFetched,
    sourceDeferred: summary.sourceDeferred,
  });
}

export function createSyncService({
  repository,
  classifier,
  analysisVersion,
  triage = triageRecruitmentMessage,
  concurrency = resolveConcurrency(process.env.SYNC_CONCURRENCY),
  messageTimeoutMs = DEFAULT_TIMEOUTS.messageMs,
  preflightTimeoutMs = DEFAULT_TIMEOUTS.preflightMs,
}) {
  return {
    async syncMessages({ accountId, mailboxEmail, from, to, messages = [], source = 'imap', sourceStats, classifierOverride, dryRun = false, signal, preflight, onProgress = () => {} }) {
      if (Date.parse(from) > Date.parse(to)) {
        throw new Error('from must be earlier than or equal to to');
      }

      const summary = {
        inserted: 0,
        analyzed: 0,
        skipped: 0,
        ignored: 0,
        candidates: 0,
        results: [],
        modelFailed: 0,
        failures: [],
        processed: 0,
        total: 0,
        remaining: 0,
        stopReason: null,
        retryFrom: null,
        ...sourceStats,
      };
      const emit = (event) => onProgress({ ...sourceStats, ...event, inserted: summary.inserted, analyzed: summary.analyzed, modelFailed: summary.modelFailed });
      const acknowledge = (message, outcome, messageKey, hash) => {
        if (dryRun || source !== 'imap') return;
        repository.saveImapCompletion?.({
          identity: imapReceiptIdentity({ accountId, mailboxEmail, analysisVersion, message }),
          outcome,
          receivedAt: message.receivedAt,
          messageKey,
          contentHash: hash,
        });
      };
      const analysisComplete = (existing) => repository.isAnalysisComplete?.(existing) ?? true;
      const compatibleLegacyRecord = (key, message) => {
        const email = actualMailboxEmail(accountId, message, mailboxEmail);
        if (!email || accountId.trim().toLowerCase() !== email || !message.provider) return null;
        const record = repository.findByKey(key);
        return record && record.account_id === accountId && record.provider === message.provider
          && record.folder === (message.folder || 'INBOX') ? record : null;
      };
      emit({ stage: 'prescreen', label: '代码预选中', total: messages.length, completed: 0 });
      const openThreads = repository.listThreads ? repository.listThreads({ accountId, routingSignals: true }) : [];
      // Classification uses one stable historical snapshot. Incremental commits
      // must not mutate the context of requests that are still in flight.
      const analysisThreads = openThreads.map((thread) => ({ ...thread }));
      const chronologicalMessages = [...messages].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

      // ── 阶段 A：预筛 + LLM 抽取（可并发） ────────────────────────────────
      // 这一段只使用单封邮件与轮初历史快照，因此可以安全并发。
      // openThreads 相关的公司名归一与线程归并全部留到阶段 B 串行执行，
      // 否则并发会破坏「按时间顺序累积线程」的既有语义。
      //
      // 注意：同一次同步内可能有多封邮件复用同一个 Message-ID（少数 ATS 会这么干）。
      // 它们的去重依赖「前一封已落库」这一事实，而阶段 A 尚未落库，因此这里必须
      // 在内存里先把本轮已占用的 key 记下来，否则两封会算出同一个主 key，
      // 到阶段 B 落库时撞 UNIQUE 约束。
      const pending = [];
      const duplicateReceipts = [];
      const claimedKeys = new Map();
      for (const message of chronologicalMessages) {
        if (signal?.aborted) signal.throwIfAborted();
        if (!inRange(message.receivedAt, from, to)) {
          if (Number.isFinite(Date.parse(message.receivedAt))) acknowledge(message, 'outside-range');
          continue;
        }

        const triageResult = triage({
          subject: message.subject,
          text: message.text,
          sender: message.sender,
        });
        if (triageResult.decision === 'ignore') {
          summary.ignored += 1;
          acknowledge(message, 'ignored');
          continue;
        }
        summary.candidates += 1;
        if (dryRun) continue;

        // 离线重放（scripts/reanalyze.mjs）会显式带上库内已存在的 messageKey。
        // 那种情况下这一行的身份以库内记录为准：主键用它自己，内容指纹用 existing.content_hash。
        //
        // 不能拿重放文本重算指纹：body_text 是存档（上限 24000 字符），而
        // content_hash 保存原处理轮次的源文本指纹。历史截断或处理策略变化可能使
        // 当前存档无法重建原指纹。若用存档文本重算并写回，下次真同步
        // 会把这些行判为「正文已变」，走下面的冲突分支把同一封邮件复制成一条 |imap| 新记录。
        const replayKey = typeof message.messageKey === 'string' && message.messageKey
          ? message.messageKey
          : null;
        const replayed = replayKey ? repository.findByKey(replayKey) : null;
        const hash = replayed?.content_hash || contentHash(message);
        const primaryMessageKey = replayKey || buildMessageKey(accountId, message, mailboxEmail);
        let messageKey = primaryMessageKey;
        let existing = replayed || repository.findByKey(messageKey);
        if (!replayKey && !message.messageId && !existing) {
          const legacyKey = buildLegacyImapIdentityKey(accountId, message);
          const legacy = compatibleLegacyRecord(legacyKey, message);
          if (legacy) {
            messageKey = legacyKey;
            existing = legacy;
          }
        }
        // 少数 ATS 会为内容不同的通知复用同一个 Message-ID。邮件内容不同即不是重复副本，
        // 改用 IMAP UID 身份，避免后一封覆盖前一封。冲突可能来自两处：
        //   1) 库里已有同 key 但内容不同的记录（跨轮次）
        //   2) 本轮稍早的一封已占用该 key（同一轮次，尚未落库）
        // 两者都必须退到 IMAP 身份，否则阶段 B 落库时会撞 UNIQUE 约束。
        // 重放不参与这套推断：它的 key 已经是最终主键。
        const collides = replayed
          ? false
          : existing
            ? existing.content_hash !== hash
            : message.messageId && claimedKeys.has(messageKey) && claimedKeys.get(messageKey) !== hash;
        if (message.messageId && collides) {
          messageKey = `${primaryMessageKey}|imap|${buildImapIdentityKey(accountId, message, mailboxEmail)}`;
          existing = repository.findByKey(messageKey);
          if (!existing) {
            const legacyKey = `${primaryMessageKey}|imap|${buildLegacyImapIdentityKey(accountId, message)}`;
            const legacy = compatibleLegacyRecord(legacyKey, message);
            if (legacy) {
              messageKey = legacyKey;
              existing = legacy;
            }
          }
        }
        if (existing && existing.content_hash === hash && existing.analysis_version === analysisVersion && analysisComplete(existing)) {
          summary.skipped += 1;
          acknowledge(message, 'analyzed', messageKey, hash);
          continue;
        }
        if (claimedKeys.get(messageKey) === hash) {
          summary.skipped += 1;
          duplicateReceipts.push({ message, messageKey, hash });
          continue;
        }
        claimedKeys.set(messageKey, hash);

        pending.push({ message, triageResult, hash, messageKey, existing });
      }
      summary.total = pending.length;
      emit({ stage: 'prescreen', label: '代码预选完成', total: messages.length, completed: messages.length, candidates: summary.candidates, ignored: summary.ignored, skipped: summary.skipped });

      if (pending.length === 0) {
        if (!dryRun) recordSyncRun({ repository, accountId, from, to, source, summary });
        return summary;
      }

      if (preflight) {
        emit({ stage: 'model_connecting', label: 'Agent连通性确认中', total: pending.length, completed: 0 });
        await withDeadline(preflight, { timeoutMs: preflightTimeoutMs, signal, code: 'MODEL_PREFLIGHT_TIMEOUT', label: 'Agent连通性确认' });
      }

      const analyzer = classifierOverride || classifier;
      const runClassify = (message, mailSignal) => (typeof analyzer === 'function'
        ? analyzer({
          subject: message.subject,
          text: message.text,
          sender: message.sender,
          receivedAt: message.receivedAt,
          openThreads: analysisThreads,
          signal: mailSignal,
        }, { signal: mailSignal })
        : analyzer.classify({
          subject: message.subject,
          text: message.text,
          sender: message.sender,
          receivedAt: message.receivedAt,
          openThreads: analysisThreads,
          signal: mailSignal,
        }, { signal: mailSignal }));

      // 单封邮件的重试策略。并发下每封各自独立重试，不会互相影响。
      const classifyWithRetry = async (message) => {
        try {
          const analysis = await withDeadline(async (mailSignal) => {
            for (let attempt = 0; attempt < MAX_CLASSIFY_ATTEMPTS; attempt += 1) {
              mailSignal.throwIfAborted();
              try {
                return await runClassify(message, mailSignal);
              } catch (error) {
                if (mailSignal.aborted || (NON_RETRYABLE_ERROR_CODES.has(error?.code) || RUN_ABORTING_ERROR_CODES.has(error?.code)) || attempt === MAX_CLASSIFY_ATTEMPTS - 1) throw error;
              }
            }
          }, { timeoutMs: messageTimeoutMs, signal, code: 'MODEL_TIMEOUT', label: '单封邮件分析（含重试）' });
          return { analysis, failure: null };
        } catch (error) {
          if (signal?.aborted) return { analysis: null, deferred: true };
          return {
            analysis: null,
            failure: {
              receivedAt: message.receivedAt,
              subject: String(message.subject || '').slice(0, 200),
              error: typeof error?.code === 'string'
                ? error.code
                : (error instanceof Error ? error.constructor.name : 'Error'),
              message: redactErrorMessage(error instanceof Error ? error.message : ''),
            },
            abortRun: RUN_ABORTING_ERROR_CODES.has(error?.code),
          };
        }
      };

      // Stop new dispatch on permanent provider failures, keeping pending mail retryable.
      let stopReason = null;
      let completed = 0;
      emit({ stage: 'analyzing', label: 'Agent解析中', total: pending.length, completed });
      const extracted = mapInOrder(
        pending,
        async (item) => {
          if (signal?.aborted) return { analysis: null, deferred: true };
          const result = await classifyWithRetry(item.message);
          if (result.abortRun) stopReason ||= result.failure.error;
          if (!result.deferred) completed += 1;
          emit({ stage: 'analyzing', label: 'Agent解析中', total: pending.length, completed });
          return result;
        },
        concurrency,
        () => Boolean(stopReason) || Boolean(signal?.aborted),
      );

      // ── 阶段 B：每封完成即按时间归并、落库，不等待整批分析 ────────────
      for await (const { index, result: extractedResult } of extracted) {
        const { message, triageResult, hash, messageKey } = pending[index];
        const { existing } = pending[index];
        if (extractedResult.deferred || signal?.aborted) continue;
        summary.processed += 1;
        if (!extractedResult.analysis) {
          if (extractedResult.failure) {
            summary.modelFailed += 1;
            summary.failures.push(extractedResult.failure);
          }
          emit({ stage: 'analyzing', label: 'Agent解析中', total: pending.length, completed });
          continue;
        }
        const analysis = extractedResult.analysis;

        // A user may merge or split applications while a model request is pending.
        // Resolve against the current visible ownership, not the dispatch-time snapshot.
        if (repository.listThreads) openThreads.splice(0, openThreads.length,
          ...repository.listThreads({ accountId, routingSignals: true }));

        const evidenceStatus = deriveStatusFromEvidence(message);
        const modelPosition = normalizePositionName(analysis.position);
        const linkForStatus = (status) => (status === '测评中'
          ? extractActionLink(message)
          : (status === '面试' ? extractInterviewLink(message) : ''));
        const mergedStatus = evidenceStatus || analysis.status;
        // 模型 false-negative 只接受两种可独立核验的强证据：个人投递成功，或
        // 明确测评信号同时带有可操作链接。普通“校招/测评”宣传标题不能单独入库。
        const isStrongProgress = (triageResult.signal === 'submitted' && evidenceStatus === '已投递')
          || (triageResult.signal === 'assessment' && evidenceStatus === '测评中' && Boolean(linkForStatus(mergedStatus)));
        const isJobRelated = Boolean(analysis.isJobRelated) || isStrongProgress;
        // Re-check after evidence merging: a quoted recruitment subject in a system
        // notice must not restore a status for a non-recruitment message.
        const statusDowngraded = !isJobRelated && mergedStatus !== '已结束';
        const resolvedStatus = statusDowngraded ? '已结束' : mergedStatus;
        const actionLink = statusDowngraded ? '' : linkForStatus(mergedStatus);
        const evidenceEventWindow = resolvedStatus === '测评中'
          ? deriveEventWindowFromEvidence(message)
          : {};
        const normalizedCompany = resolveCompanyName({
          company: normalizeCompany(analysis.company),
          openThreads,
        });
        const notes = buildProgressNotes({
          status: resolvedStatus,
          actionLink,
          eventEnd: evidenceEventWindow.eventEnd || analysis.eventEnd,
        });
        const normalizedAnalysis = {
          ...analysis,
          // 公司和岗位语义以模型输出为准；这里只做格式清理、通用状态/时间和链接归一。
          isJobRelated,
          company: normalizedCompany,
          position: modelPosition,
          // 被降级说明模型与证据在这封邮件上打架（典型是退信/系统通知在标题里引用了
          // 原邮件主题），标出来让人能在页面上复核并改回，而不是静默按「已结束」归档。
          needsReview: Boolean(analysis.needsReview) || statusDowngraded,
          status: resolvedStatus,
          ...(evidenceStatus && evidenceStatus !== analysis.status && !statusDowngraded
            ? { nextAction: NEXT_ACTION_BY_STATUS[evidenceStatus] }
            : {}),
          notes,
          ...(resolvedStatus === '测评中'
            ? {
              eventStart: evidenceEventWindow.eventStart || new Date(message.receivedAt).toISOString(),
              ...(evidenceEventWindow.eventEnd ? { eventEnd: evidenceEventWindow.eventEnd } : {}),
            }
            : {}),
        };
        const record = {
          messageKey,
          messageId: message.messageId || null,
          accountId,
          provider: message.provider || 'unknown',
          folder: message.folder || 'INBOX',
          receivedAt: new Date(message.receivedAt).toISOString(),
          sender: message.sender || '',
          subject: message.subject || '',
          contentHash: hash,
          analysisVersion,
          analysis: normalizedAnalysis,
          webUrl: message.webUrl || null,
          bodyText: typeof message.text === 'string' ? message.text.slice(0, 24_000) : null,
          bodyHtml: typeof message.html === 'string' ? message.html.slice(0, 300_000) : null,
          analyzedAt: new Date().toISOString(),
        };

        const saved = repository.saveAnalysis(record, existing);
        const pinnedTargets = existing && saved?.id
          ? (repository.listManualThreadRoutesForMessage?.(saved.id) || [])
          : [];
        const manualTarget = existing && saved?.id
          ? repository.findManualOverrideThreadForMessage?.(saved.id)
          : null;
        if (!normalizedAnalysis.isJobRelated && existing && saved?.id && !manualTarget && !pinnedTargets.length) {
          repository.unlinkMessageFromThreads?.(saved.id);
          repository.deleteOrphanEmailThreads?.();
          if (repository.listThreads) {
            openThreads.splice(0, openThreads.length, ...repository.listThreads({ accountId, routingSignals: true }));
          }
        }
        if (saved?.id && pinnedTargets.length) {
          // The confirmed owner set is authoritative, including shared assessment mail.
          // A model replay may refine the archive but cannot expand or erase this set.
          for (const target of pinnedTargets) {
            repository.linkMessageToThread?.(target.id,saved.id,record.analyzedAt);
            repository.refreshThreadFromHistory?.(target.id);
          }
          openThreads.splice(0,openThreads.length,...repository.listThreads({accountId,routingSignals:true}));
        } else if (normalizedAnalysis.isJobRelated && saved?.id) {
          // 重分析可能修正公司/岗位/申请路线。先解除这封邮件的旧归属，随后按本轮
          // 结果重新关联，避免一封邮件同时残留在旧线程和新线程中。
          // 人工更新的申请保留明确归属与岗位，旧邮件重分析不可迁走或清空它。
          // 邮件档案仍保留模型分析；状态是否更新由手动记录时间与邮件时间决定。
          if (existing && !manualTarget) repository.unlinkMessageFromThreads?.(saved.id);
          const placement = manualTarget
            ? {
              mainThreadId: manualTarget.id,
              fanoutIds: [],
              created: false,
              sanitizedAnalysis: {
                ...normalizedAnalysis,
                company: manualTarget.company,
                position: manualTarget.position,
                needsReview: false,
              },
            }
            : resolveThreadPlacement({ threads: openThreads, analysis: normalizedAnalysis, message });
          const sanitized = placement.sanitizedAnalysis;
          const threadId = manualTarget?.id || repository.upsertThreadFromMessage({
            threadId: placement.mainThreadId,
            accountId,
            company: sanitized.company,
            position: sanitized.position || '',
            status: sanitized.status,
            confidence: sanitized.confidence,
            needsReview: sanitized.needsReview,
            evidence: sanitized.evidence,
            nextAction: sanitized.nextAction,
            notes: sanitized.notes,
            eventStart: sanitized.eventStart,
            eventEnd: sanitized.eventEnd,
            receivedAt: record.receivedAt,
            messageId: saved.id,
            forceNew: placement.created,
          });
          repository.linkMessageToThread?.(threadId, saved.id, record.analyzedAt);
          if (manualTarget) repository.refreshThreadFromHistory?.(threadId);
          for (const fanoutId of placement.fanoutIds) {
            if (fanoutId === threadId) continue;
            repository.touchThreadStatus(fanoutId, {
              status: sanitized.status,
              receivedAt: record.receivedAt,
              messageId: saved.id,
              eventStart: sanitized.eventStart,
              eventEnd: sanitized.eventEnd,
              notes: sanitized.notes,
            });
            repository.linkMessageToThread?.(fanoutId, saved.id, record.analyzedAt);
          }
          if (existing) repository.deleteOrphanEmailThreads?.();
          // Old mail can be rejected by the repository. Feed the next placement
          // only the committed state, rather than overwriting it with the attempted update.
          if (repository.listThreads) openThreads.splice(0, openThreads.length,
            ...repository.listThreads({ accountId, routingSignals: true }));
        }
        if (existing) {
          summary.analyzed += 1;
        } else {
          summary.inserted += 1;
          summary.analyzed += 1;
        }
        summary.results.push({
          messageKey,
          receivedAt: record.receivedAt,
          sender: record.sender,
          subject: record.subject,
          ...normalizedAnalysis,
        });
        acknowledge(message, 'analyzed', messageKey, hash);
        emit({ stage: 'analyzing', label: 'Agent解析中', total: pending.length, completed, changed: true, receivedAt: record.receivedAt });
      }

      summary.remaining = pending.length - summary.processed;
      // Same-run copies only become complete after their shared analysis commits;
      // a failed or cancelled original must leave every copy retryable.
      for (const { message, messageKey, hash } of duplicateReceipts) {
        acknowledge(message, 'analyzed', messageKey, hash);
      }
      summary.stopReason = signal?.aborted ? (signal.reason?.code || 'SYNC_CANCELLED') : stopReason;
      const retryDates = [
        ...summary.failures.map((failure) => failure.receivedAt),
        ...pending.slice(summary.processed).map((item) => item.message.receivedAt),
      ].map(Date.parse).filter(Number.isFinite);
      if (retryDates.length) summary.retryFrom = new Date(Math.min(...retryDates)).toISOString();

      if (!dryRun) {
        recordSyncRun({ repository, accountId, from, to, source, summary });
      }
      return summary;
    },
  };
}
