import { createHash } from 'node:crypto';
import { triageRecruitmentMessage } from '../domain/triage.js';
import { resolveThreadPlacement } from '../domain/thread-resolver.js';
import {
  deriveEventWindowFromEvidence,
  deriveStatusFromEvidence,
  extractActionLink,
  extractInterviewLink,
  inferCompanyFromEvidence,
  normalizePositionName,
} from '../domain/normalize.js';
import { buildProgressNotes } from '../domain/progress-notes.js';
import { resolveCompanyName } from '../domain/company-resolver.js';

const NEXT_ACTION_BY_STATUS = {
  已投递: '等待后续通知',
  测评中: '完成测评',
  面试: '准备并参加面试',
  Offer: '确认录用安排',
  已结束: '归档该申请',
};
const MAX_CLASSIFY_ATTEMPTS = 3;

function buildMessageKey(accountId, message) {
  if (message.messageId) return `${accountId}|message-id|${message.messageId}`;
  return [
    accountId,
    message.folder || 'INBOX',
    message.uidValidity || 'unknown',
    message.uid || message.receivedAt,
  ].join('|');
}

function buildImapIdentityKey(accountId, message) {
  return [
    accountId,
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

export function createSyncService({ repository, classifier, analysisVersion, triage = triageRecruitmentMessage }) {
  return {
    async syncMessages({ accountId, from, to, messages = [], source = 'imap', classifierOverride, dryRun = false }) {
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
      };
      const openThreads = repository.listThreads ? repository.listThreads({ accountId, routingSignals: true }) : [];
      const chronologicalMessages = [...messages].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      for (const message of chronologicalMessages) {
        if (!inRange(message.receivedAt, from, to)) continue;

        const triageResult = triage({
          subject: message.subject,
          text: message.text,
          sender: message.sender,
        });
        if (triageResult.decision === 'ignore') {
          summary.ignored += 1;
          continue;
        }
        summary.candidates += 1;
        if (dryRun) continue;

        const hash = contentHash(message);
        const primaryMessageKey = buildMessageKey(accountId, message);
        let messageKey = primaryMessageKey;
        let existing = repository.findByKey(messageKey);
        // 少数 ATS 会为内容不同的通知复用同一个 Message-ID。
        // 邮件内容不同即不是重复副本，改用 IMAP UID 身份，避免后一封覆盖前一封。
        if (message.messageId && existing && existing.content_hash !== hash) {
          messageKey = `${primaryMessageKey}|imap|${buildImapIdentityKey(accountId, message)}`;
          existing = repository.findByKey(messageKey);
        }
        if (existing && existing.content_hash === hash && existing.analysis_version === analysisVersion) {
          summary.skipped += 1;
          continue;
        }

        let analysis = null;
        let modelFailedCounted = false;
        let abortRemainingMessages = false;
        for (let attempt = 0; attempt < MAX_CLASSIFY_ATTEMPTS; attempt += 1) {
          try {
            const analyzer = classifierOverride || classifier;
            const classifyInput = {
              subject: message.subject,
              text: message.text,
              sender: message.sender,
              receivedAt: message.receivedAt,
              openThreads,
            };
            const raw = typeof analyzer === 'function'
              ? await analyzer(classifyInput)
              : await analyzer.classify(classifyInput);
            analysis = raw;
            break;
          } catch (error) {
            const nonRetryable = error?.code === 'MODEL_RATE_LIMITED';
            if (nonRetryable || attempt === MAX_CLASSIFY_ATTEMPTS - 1) {
              summary.modelFailed += 1;
              summary.failures.push({
                receivedAt: message.receivedAt,
                subject: String(message.subject || '').slice(0, 200),
                error: typeof error?.code === 'string'
                  ? error.code
                  : (error instanceof Error ? error.constructor.name : 'Error'),
              });
              modelFailedCounted = true;
              abortRemainingMessages = nonRetryable;
              break;
            }
          }
        }
        if (modelFailedCounted) {
          if (abortRemainingMessages) break;
          continue;
        }

        const evidenceStatus = deriveStatusFromEvidence(message);
        const modelPosition = normalizePositionName(analysis.position);
        const resolvedStatus = evidenceStatus || analysis.status;
        const actionLink = resolvedStatus === '测评中'
          ? extractActionLink(message)
          : (resolvedStatus === '面试' ? extractInterviewLink(message) : '');
        // 模型 false-negative 只接受两种可独立核验的强证据：个人投递成功，或
        // 明确测评信号同时带有可操作链接。普通“校招/测评”宣传标题不能单独入库。
        const isStrongProgress = (triageResult.signal === 'submitted' && evidenceStatus === '已投递')
          || (triageResult.signal === 'assessment' && evidenceStatus === '测评中' && Boolean(actionLink));
        const evidenceEventWindow = resolvedStatus === '测评中'
          ? deriveEventWindowFromEvidence(message)
          : {};
        const normalizedCompany = resolveCompanyName({
          company: inferCompanyFromEvidence({
            company: analysis.company,
            sender: message.sender,
            subject: message.subject,
            text: message.text,
          }),
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
          isJobRelated: Boolean(analysis.isJobRelated) || isStrongProgress,
          company: normalizedCompany,
          position: modelPosition,
          needsReview: Boolean(analysis.needsReview),
          status: resolvedStatus,
          ...(evidenceStatus && evidenceStatus !== analysis.status
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
        const manualTarget = existing && saved?.id
          ? repository.findManualPositionOverrideThreadForMessage?.(saved.id)
          : null;
        if (!normalizedAnalysis.isJobRelated && existing && saved?.id && !manualTarget) {
          repository.unlinkMessageFromThreads?.(saved.id);
          repository.deleteOrphanEmailThreads?.();
          if (repository.listThreads) {
            openThreads.splice(0, openThreads.length, ...repository.listThreads({ accountId, routingSignals: true }));
          }
        }
        if (normalizedAnalysis.isJobRelated && saved?.id) {
          // 重分析可能修正公司/岗位/申请路线。先解除这封邮件的旧归属，随后按本轮
          // 结果重新关联，避免一封邮件同时残留在旧线程和新线程中。
          // 若用户已人工修正岗位，则邮件档案仍保留本轮“未识别岗位”的自动分析，
          // 但申请线程继续采用人工值，且不得被重分析迁走或清空。
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
          const threadId = repository.upsertThreadFromMessage({
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
            forceNew: !manualTarget && placement.created,
          });
          repository.linkMessageToThread?.(threadId, saved.id, record.analyzedAt);
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
          if (existing) {
            repository.deleteOrphanEmailThreads?.();
            if (repository.listThreads) {
              openThreads.splice(0, openThreads.length, ...repository.listThreads({ accountId, routingSignals: true }));
            }
          }
          // openThreads 内存副本同步维护，避免循环内重复查询
          const threadEntry = {
            id: threadId,
            accountId,
            company: sanitized.company,
            position: sanitized.position || '',
            status: sanitized.status,
            latestReceivedAt: record.receivedAt,
            latestSender: record.sender,
          };
          const threadIndex = openThreads.findIndex((thread) => thread.id === threadId);
          if (threadIndex >= 0) openThreads[threadIndex] = { ...openThreads[threadIndex], ...threadEntry };
          else openThreads.push(threadEntry);
          for (const fanoutId of placement.fanoutIds) {
            const fanoutIndex = openThreads.findIndex((thread) => thread.id === fanoutId);
            if (fanoutIndex >= 0) openThreads[fanoutIndex] = { ...openThreads[fanoutIndex], status: sanitized.status };
          }
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
      }

      if (!dryRun) {
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
        });
      }
      return summary;
    },
  };
}
