import { createHash } from 'node:crypto';
import { triageRecruitmentMessage } from '../domain/triage.js';
import { resolveThreadPlacement } from '../domain/thread-resolver.js';
import { normalizeCompany, extractPositionFromSubject, extractPositionFromText } from '../domain/normalize.js';

function buildMessageKey(accountId, message) {
  if (message.messageId) return `${accountId}|message-id|${message.messageId}`;
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

      const summary = { inserted: 0, analyzed: 0, skipped: 0, ignored: 0, candidates: 0, results: [], modelFailed: 0 };
      const openThreads = repository.listThreads ? repository.listThreads({}) : [];
      for (const message of messages) {
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

        const messageKey = buildMessageKey(accountId, message);
        const hash = contentHash(message);
        const existing = repository.findByKey(messageKey);
        if (existing && existing.content_hash === hash && existing.analysis_version === analysisVersion) {
          summary.skipped += 1;
          continue;
        }

        let analysis = null;
        let modelFailedCounted = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
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
            if (attempt === 1) {
              summary.modelFailed += 1;
              modelFailedCounted = true;
            }
          }
        }
        if (modelFailedCounted) continue;

        const normalizedAnalysis = {
          ...analysis,
          // 确定性规则兜底：公司名归一、position 空时依次从 subject/正文高置信模式抽取
          company: normalizeCompany(analysis.company),
          ...(analysis.isJobRelated && !String(analysis.position || '').trim()
            ? { position: extractPositionFromSubject(message.subject) || extractPositionFromText(message.text || '') }
            : {}),
          ...(analysis.status === '测评中' && analysis.eventEnd
            ? { eventStart: new Date(message.receivedAt).toISOString() }
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
        if (normalizedAnalysis.isJobRelated && saved?.id) {
          const placement = resolveThreadPlacement({ threads: openThreads, analysis: normalizedAnalysis, message });
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
          });
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
          }
          // openThreads 内存副本同步维护，避免循环内重复查询
          const threadEntry = {
            id: threadId,
            account_id: accountId,
            company: sanitized.company,
            position: sanitized.position || '',
            status: sanitized.status,
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
        });
      }
      return summary;
    },
  };
}
