import { ApiError } from './errors.js';
import { buildProgressNotes } from './domain/progress-notes.js';
import { companyComparisonKey } from './domain/company-resolver.js';
import { ALLOWED_PROGRESS_STATUSES } from './domain/statuses.js';
import { redactErrorMessage } from './domain/error-message.js';
import { DEFAULT_TIMEOUTS, deadlineError, withDeadline } from './services/deadline.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DATE_ONLY_OFFSET = '+08:00';

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function normalizeWindow(value, endOfDay = false) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('date is required');
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${DATE_ONLY_OFFSET}`
    : trimmed;
  if (!Number.isFinite(Date.parse(iso))) throw new Error('date is invalid');
  return new Date(iso).toISOString();
}

// CSRF 防护：写接口必须显式声明 JSON content-type（sendBeacon/HTML 表单无法伪造），
// 且携带 Origin 头时必须指向本服务（浏览器跨站请求会自动附带 Origin）。
function assertTrustedMutation(request, config) {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('content-type must be application/json', 'FORBIDDEN');
  }
  const origin = request.headers.origin;
  if (origin) {
    const allowed = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
    if (!allowed.has(String(origin))) {
      throw new ApiError('cross-origin request rejected', 'FORBIDDEN');
    }
  }
}

export function createApi({
  config,
  repository,
  settingsService,
  syncService,
  imapSource,
  mailboxService,
  createClassifier,
}) {
  const activeMailboxes = new Set();
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.syncTimeouts };
  return async function apiHandler(request, response) {
    let streamEvent;
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const path = requestUrl.pathname;

      if (request.method === 'POST' || request.method === 'PUT') {
        assertTrustedMutation(request, config);
      }

      if (request.method === 'GET' && path === '/api/health') {
        sendJson(response, 200, { ok: true, analysisVersion: config.analysisVersion });
        return;
      }

      if (request.method === 'GET' && path === '/api/settings') {
        sendJson(response, 200, settingsService.getSettings());
        return;
      }

      if (request.method === 'POST' && path === '/api/settings/provider') {
        sendJson(response, 200, settingsService.saveProvider(await readJson(request)));
        return;
      }

      if (request.method === 'POST' && path === '/api/settings/mailbox') {
        sendJson(response, 200, settingsService.saveMailbox(await readJson(request)));
        return;
      }

      if (request.method === 'POST' && path === '/api/model/test') {
        const startedAt = Date.now();
        const settings = settingsService.getSettings();
        const provider = settings.providers.find((item) => item.id === settings.activeProviderId);
        await withDeadline(async (signal) => {
          const classifier = await createClassifier?.();
          if (!classifier?.checkConnection) throw new ApiError('尚未配置可用的分析模型', 'MODEL_UNAVAILABLE');
          await classifier.checkConnection({ signal });
        }, { timeoutMs: timeouts.preflightMs, code: 'MODEL_PREFLIGHT_TIMEOUT', label: '模型连通性确认' });
        sendJson(response, 200, { ok: true, providerId: provider?.id, model: provider?.model, elapsedMs: Date.now() - startedAt });
        return;
      }

      if (request.method === 'POST' && path === '/api/mailbox/test') {
        if (!mailboxService) throw new Error('IMAP mailbox service is unavailable');
        const input = await readJson(request);
        const saved = settingsService.getMailboxConnection?.();
        const result = await withDeadline((signal) => mailboxService.testConnection({
          provider: input.provider || saved?.provider,
          email: input.email || saved?.email,
          authorizationCode: input.authorizationCode || saved?.authorizationCode,
        }, { signal }), { timeoutMs: timeouts.connectMs + timeouts.logoutMs, code: 'IMAP_CONNECT_TIMEOUT', label: '邮箱连接测试' });
        if (result.message) result.message = redactErrorMessage(result.message);
        sendJson(response, result.ok ? 200 : 502, result);
        return;
      }

      if (request.method === 'GET' && path === '/api/dashboard') {
        const fromValue = requestUrl.searchParams.get('from');
        const toValue = requestUrl.searchParams.get('to');
        const filters = {
          from: fromValue ? normalizeWindow(fromValue, false) : undefined,
          to: toValue ? normalizeWindow(toValue, true) : undefined,
        };
        if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
          throw new Error('from must be earlier than or equal to to');
        }
        const recent = repository.listThreads(filters);
        sendJson(response, 200, {
          total: recent.length,
          counts: repository.getCountsByThreads(filters),
          recent,
        });
        return;
      }

      if (request.method === 'GET' && path === '/api/sync/runs') {
        sendJson(response, 200, repository.listSyncRuns(requestUrl.searchParams.get('limit')));
        return;
      }

      if (request.method === 'POST' && path === '/api/sync/run') {
        const input = await withDeadline(() => readJson(request), { timeoutMs: 10_000, code: 'REQUEST_TIMEOUT', label: '读取同步请求' });
        if (input.source && input.source !== 'imap') throw new Error('source must be imap');
        const source = 'imap';
        const mailbox = settingsService.getMailboxConnection?.();
        if (!imapSource || !mailbox?.email || !mailbox.authorizationCode) throw new ApiError('mailbox is not configured', 'MAILBOX_CONFIG');
        const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? input.accountId.trim() : mailbox.email;
        let from = input.from ? normalizeWindow(input.from, false) : undefined;
        let to = input.to ? normalizeWindow(input.to, true) : undefined;
        const dryRun = input.dryRun === true;
        const maxMessages = input.maxMessages == null ? undefined : Number(input.maxMessages);
        if (maxMessages !== undefined && (!Number.isInteger(maxMessages) || maxMessages < 1)) throw new Error('maxMessages must be a positive integer');
        if (input.auto) {
          const watermark = repository.getSetting(`sync.watermark.${accountId}`);
          const fallbackStart = new Date(Date.now() - 30 * 86_400_000);
          const startDay = watermark ? new Date(Date.parse(watermark)).toISOString().slice(0, 10) : fallbackStart.toISOString().slice(0, 10);
          from = normalizeWindow(startDay, false);
          to = normalizeWindow(new Date().toISOString().slice(0, 10), true);
        }
        if (!from || !to) throw new Error('from and to are required');
        if (Date.parse(from) > Date.parse(to)) throw new Error('from must be earlier than or equal to to');
        const mailboxKey = mailbox.email.toLowerCase();
        if (activeMailboxes.has(mailboxKey)) throw new ApiError('该邮箱正在同步，请等待完成或取消当前同步', 'SYNC_IN_PROGRESS');
        activeMailboxes.add(mailboxKey);
        const controller = new AbortController();
        const startedAt = Date.now();
        const runTimer = setTimeout(() => controller.abort(deadlineError('SYNC_RUN_TIMEOUT', '本轮同步', timeouts.runMs)), timeouts.runMs);
        const cancel = () => { if (!response.writableEnded) controller.abort(new ApiError('同步已取消，已写入的记录保留', 'SYNC_CANCELLED')); };
        response.once('close', cancel);
        let heartbeat;
        let latest;
        const emit = (event) => {
          const stageChanged = event.stage !== latest?.stage;
          const stageTimeout = { connecting: timeouts.connectMs, opening: timeouts.lockMs, searching: timeouts.searchMs, fetching: timeouts.fetchMs, parsing: timeouts.parseMs, model_connecting: timeouts.preflightMs, analyzing: timeouts.messageMs }[event.stage];
          latest = { ...event, type: 'progress', stageStartedAt: stageChanged ? Date.now() : latest.stageStartedAt, stepTimeoutMs: stageTimeout, runTimeoutMs: timeouts.runMs, elapsedMs: Date.now() - startedAt };
          streamEvent?.(latest);
        };
        if (input.stream === true) {
          response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
          response.flushHeaders();
          streamEvent = (event) => {
            if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
          };
          heartbeat = setInterval(() => { if (latest) streamEvent({ ...latest, changed: false, heartbeat: true, elapsedMs: Date.now() - startedAt }); }, 2_000);
        }
        try {
          // Constructing the classifier only validates local configuration. The
          // actual model probe runs after prescreen, only when there is work.
          const classifierOverride = dryRun ? undefined : await withDeadline(() => createClassifier?.(), { timeoutMs: timeouts.preflightMs, signal: controller.signal, code: 'MODEL_PREFLIGHT_TIMEOUT', label: '读取模型配置' });
          if (!dryRun && !classifierOverride) throw new ApiError('model is not configured', 'MODEL_UNAVAILABLE');
          emit({ stage: 'connecting', label: '邮箱连接中' });
          let messages;
          let sourceStats;
          try {
            messages = await withDeadline((signal) => imapSource.fetchMessages({ accountId, provider: mailbox.provider, email: mailbox.email, authorizationCode: mailbox.authorizationCode, from, to, maxMessages, dryRun, signal, onProgress: emit, onSelection: (stats) => { sourceStats = stats; } }), { timeoutMs: timeouts.runMs, signal: controller.signal, code: 'SYNC_RUN_TIMEOUT', label: '邮件读取' });
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error?.code?.includes('TIMEOUT') || error?.code === 'SYNC_CANCELLED') throw error;
            throw new ApiError(`imap fetch failed: ${redactErrorMessage(error instanceof Error ? error.message : String(error))}`, 'MAILBOX_CONFIG');
          }
          const summary = await syncService.syncMessages({ accountId, mailboxEmail: mailbox.email, from, to, messages, source, sourceStats, classifierOverride, dryRun,
            signal: controller.signal, onProgress: emit,
            preflight: !dryRun && classifierOverride?.checkConnection ? (signal) => classifierOverride.checkConnection({ signal }) : undefined,
          });
          if (!dryRun) {
            // Deferred mail matters as much as explicit failures: a rate limit,
            // cancellation or run deadline must never advance past either one.
            const retryTimes = [summary.retryFrom, ...(summary.failures || []).map((failure) => failure.receivedAt)].map(Date.parse).filter(Number.isFinite);
            const watermark = sourceStats?.sourceDeferred > 0 || (!sourceStats && maxMessages != null && messages.length >= maxMessages) ? from
              : retryTimes.length ? new Date(Math.min(...retryTimes) - 1).toISOString() : to;
            repository.saveSetting(`sync.watermark.${accountId}`, watermark);
          }
          const result = { ...summary, mode: source, accountId, from, to, dryRun, maxMessages: maxMessages ?? null };
          if (streamEvent) { streamEvent({ type: 'complete', summary: result, elapsedMs: Date.now() - startedAt }); response.end(); }
          else sendJson(response, 200, result);
        } finally {
          clearInterval(heartbeat);
          clearTimeout(runTimer);
          response.removeListener('close', cancel);
          controller.abort(new ApiError('同步已结束', 'SYNC_CANCELLED'));
          activeMailboxes.delete(mailboxKey);
        }
        return;
      }

      const assertCurrentApplication = (id) => {
        const row = repository.getThread(Number(id));
        if (!row || row.mergedIntoThreadId) throw new ApiError('申请不存在或已归入其他申请', 'PROGRESS_NOT_FOUND');
        const account = settingsService.getSettings().mailbox?.email || 'manual';
        if (row.accountId !== account && row.accountId !== 'manual') throw new ApiError('申请不属于当前邮箱', 'FORBIDDEN');
        return row;
      };
      if (['GET','POST'].includes(request.method) && path === '/api/progress/merge-preview') {
        const input = request.method === 'POST' ? await readJson(request) : {
          targetId: requestUrl.searchParams.get('targetId'),
          sourceIds: (requestUrl.searchParams.get('sourceIds') || '').split(',').map(Number),
        };
        const targetId = Number(input.targetId);
        const sourceIds = input.sourceIds;
        if (!Array.isArray(sourceIds)) throw new Error('请选择待合并申请');
        if (input.progress != null && (typeof input.progress !== 'object' || Array.isArray(input.progress))) throw new Error('申请进展无效');
        assertCurrentApplication(targetId);
        sourceIds.forEach(assertCurrentApplication);
        sendJson(response, 200, repository.previewThreadMerge({targetId,sourceIds,progress:input.progress}));
        return;
      }
      if (request.method === 'POST' && path === '/api/progress/merge') {
        const input = await readJson(request);
        assertCurrentApplication(input.targetId);
        if (!Array.isArray(input.sourceIds) || !input.sourceIds.length) throw new Error('请选择待合并申请');
        input.sourceIds.forEach(assertCurrentApplication);
        if (input.progress != null && (typeof input.progress !== 'object' || Array.isArray(input.progress))) throw new Error('申请进展无效');
        sendJson(response, 200, repository.mergeThreads({targetId:Number(input.targetId),sourceIds:input.sourceIds,
          progress:input.progress,expectedUpdatedAt:input.expectedUpdatedAt}));
        return;
      }
      const structureMatch = path.match(/^\/api\/progress\/(\d+)\/structure$/);
      if (request.method === 'GET' && structureMatch) {
        assertCurrentApplication(structureMatch[1]);
        sendJson(response, 200, repository.getThreadStructure(Number(structureMatch[1])));
        return;
      }
      const splitMatch = path.match(/^\/api\/progress\/(\d+)\/split$/);
      if (request.method === 'POST' && splitMatch) {
        const input = await readJson(request);
        assertCurrentApplication(splitMatch[1]);
        sendJson(response, 200, repository.splitThread({...input,threadId:Number(splitMatch[1])}));
        return;
      }
      const splitPreviewMatch = path.match(/^\/api\/progress\/(\d+)\/split-preview$/);
      if (request.method === 'POST' && splitPreviewMatch) {
        const input = await readJson(request);
        assertCurrentApplication(splitPreviewMatch[1]);
        sendJson(response, 200, repository.previewThreadSplit({...input,threadId:Number(splitPreviewMatch[1])}));
        return;
      }
      const restoreMatch = path.match(/^\/api\/progress\/(\d+)\/(restore-preview|restore)$/);
      if (request.method === 'POST' && restoreMatch) {
        const input = await readJson(request);
        assertCurrentApplication(restoreMatch[1]);
        const action = restoreMatch[2] === 'restore-preview' ? 'previewRestoreMerge' : 'restoreMerge';
        sendJson(response, 200, repository[action]({...input,threadId:Number(restoreMatch[1])}));
        return;
      }

      if (request.method === 'POST' && path === '/api/progress/manual') {
        const input = await readJson(request);
        const mailboxAccount = settingsService.getSettings().mailbox?.email || 'manual';
        const threadId = input.threadId == null ? null : Number(input.threadId);
        if (threadId != null && (!Number.isInteger(threadId) || threadId <= 0)) throw new Error('threadId is invalid');
        const target = threadId ? repository.getThread(threadId) : null;
        if (threadId && (!target || target.mergedIntoThreadId)) { sendJson(response, 404, { error: '所选申请不存在或已归入其他申请' }); return; }
        const belongsToMailbox = (row) => row.accountId === mailboxAccount || row.accountId === 'manual';
        if (target && !belongsToMailbox(target)) throw new ApiError('所选申请不属于当前邮箱', 'FORBIDDEN');
        let company = typeof input.company === 'string' ? input.company.trim() : '';
        let position = typeof input.position === 'string' ? input.position.trim() : '';
        if (target) {
          if (company && companyComparisonKey(company) !== companyComparisonKey(target.company)) throw new Error('公司与所选申请不一致，请确认更新对象');
          company = target.company;
          position ||= target.position;
        }
        const mergeFromId = input.mergeFromId == null ? null : Number(input.mergeFromId);
        if (mergeFromId != null) {
          const source = Number.isInteger(mergeFromId) && mergeFromId > 0 ? repository.getThread(mergeFromId) : null;
          if (!target || !source || source.source !== 'manual' || source.mergedIntoThreadId || source.id === target.id
            || !belongsToMailbox(source)) throw new Error('只能将当前邮箱的独立手动申请归入另一条已有申请');
        }
        const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
        const rawNotes = typeof input.notes === 'string' ? input.notes.trim() : evidence;
        const nextAction = typeof input.nextAction === 'string' ? input.nextAction.trim() : '由用户手动维护';
        if (!company || (!target && !position)) {
          throw new Error('company and position are required');
        }
        if (!ALLOWED_PROGRESS_STATUSES.has(input.status)) throw new Error('status is invalid');
        const receivedAt = input.receivedAt || new Date().toISOString();
        const eventStart = input.eventStart || receivedAt;
        if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('receivedAt is invalid');
        if (!Number.isFinite(Date.parse(eventStart))) throw new Error('eventStart is invalid');
        if (input.eventEnd && (!Number.isFinite(Date.parse(input.eventEnd)) || Date.parse(input.eventEnd) < Date.parse(eventStart))) {
          throw new Error('eventEnd is invalid');
        }
        const notes = buildProgressNotes({
          status: input.status,
          notes: rawNotes,
          eventEnd: input.eventEnd,
        });
        const row = repository.applyManualProgress({
          threadId, mergeFromId, accountId: mailboxAccount,
          company,
          position,
          status: input.status,
          receivedAt,
          evidence,
          notes,
          nextAction,
          eventStart,
          eventEnd: input.eventEnd,
          webUrl: input.webUrl,
          confidence: 1,
        });
        sendJson(response, 200, row);
        return;
      }

      const manualHistoryMatch = path.match(/^\/api\/progress\/(\d+)\/manual-history$/);
      if (request.method === 'GET' && manualHistoryMatch) {
        const threadId = Number(manualHistoryMatch[1]);
        if (!repository.getThread(threadId)) { sendJson(response, 404, { error: 'progress not found' }); return; }
        sendJson(response, 200, { events: repository.listManualProgress(threadId) });
        return;
      }

      const emailMatch = path.match(/^\/api\/progress\/(\d+)\/email$/);
      if (request.method === 'GET' && emailMatch) {
        const detail = repository.getEmailDetail(Number(emailMatch[1]));
        if (!detail || (!detail.bodyText && !detail.bodyHtml)) {
          sendJson(response, 404, { error: 'email body unavailable' });
          return;
        }
        sendJson(response, 200, detail);
        return;
      }

      const emailHistoryMatch = path.match(/^\/api\/progress\/(\d+)\/emails$/);
      if (request.method === 'GET' && emailHistoryMatch) {
        const messages = repository.listThreadMessages?.(Number(emailHistoryMatch[1])) || [];
        if (!messages.length) {
          sendJson(response, 404, { error: 'email history unavailable' });
          return;
        }
        sendJson(response, 200, { threadId: Number(emailHistoryMatch[1]), messages });
        return;
      }

      const editMatch = path.match(/^\/api\/progress\/(\d+)$/);
      if (request.method === 'PUT' && editMatch) {
        const input = await readJson(request);
        const threadId = Number(editMatch[1]);
        const existingThread = repository.getThread(threadId);
        if (!existingThread || existingThread.mergedIntoThreadId) { sendJson(response, 404, { error: 'progress not found' }); return; }
        const company = typeof input.company === 'string' ? input.company.trim() : '';
        const position = typeof input.position === 'string' ? input.position.trim() : '';
        const eventStart = input.eventStart === undefined ? (input.receivedAt || existingThread.eventStart) : input.eventStart;
        const eventEnd = input.eventEnd === undefined
          ? (input.status === existingThread.status && eventStart === existingThread.eventStart ? existingThread.eventEnd : null)
          : input.eventEnd;
        if (!company || !ALLOWED_PROGRESS_STATUSES.has(input.status)) throw new Error('company and status are required');
        if (eventStart != null && (!eventStart || !Number.isFinite(Date.parse(eventStart)))) throw new Error('eventStart is invalid');
        if (eventEnd && (!eventStart || !Number.isFinite(Date.parse(eventEnd)) || Date.parse(eventEnd) < Date.parse(eventStart))) throw new Error('eventEnd is invalid');
        const patch = {
          company,
          position,
          status: input.status,
          eventStart: eventStart ? new Date(eventStart).toISOString() : null,
          eventEnd: eventEnd ? new Date(eventEnd).toISOString() : null,
          notes: buildProgressNotes({
            status: input.status,
            notes: typeof input.notes === 'string' ? input.notes.trim() : '',
            eventEnd,
          }),
          needsReview: false,
        };
        if (typeof input.evidence === 'string') patch.evidence = input.evidence.trim();
        if (typeof input.nextAction === 'string') patch.nextAction = input.nextAction.trim();
        const row = repository.applyManualProgress({ ...patch, threadId, intent: 'edit' });
        sendJson(response, 200, row);
        return;
      }

      if (request.method === 'POST' && path === '/api/progress/delete') {
        const input = await readJson(request);
        const ids = Array.isArray(input.ids)
          ? input.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
          : [];
        if (!ids.length) throw new Error('ids must contain at least one positive integer');
        // 只删除线程行，保留底层邮件档案
        sendJson(response, 200, { deleted: repository.deleteThreadByIds([...new Set(ids)]) });
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const message = redactErrorMessage(error instanceof Error ? error.message : 'request failed');
      const code = typeof error?.code === 'string' ? error.code : 'GENERIC';
      if (streamEvent) { streamEvent({ type: 'error', error: message, code }); if (!response.destroyed) response.end(); return; }
      const status = ['SYNC_IN_PROGRESS', 'PROGRESS_CONFLICT', 'PROGRESS_STALE'].includes(code) ? 409
        : code === 'PROGRESS_NOT_FOUND' ? 404
        : code.includes('TIMEOUT') ? 504
        : code === 'MODEL_OUTPUT_TRUNCATED' || code === 'MODEL_PREFLIGHT_FAILED' ? 502
        : code === 'MODEL_RATE_LIMITED' ? 429
        : ['MODEL_NOT_FOUND', 'MODEL_AUTH_FAILED', 'MODEL_ACCESS_DENIED', 'MODEL_PAYMENT_REQUIRED', 'MODEL_REQUEST_FAILED'].includes(code) ? 502
        : error instanceof ApiError && error.code === 'MAILBOX_CONFIG' ? 502
        : error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE' ? 503
        : error instanceof ApiError && error.code === 'FORBIDDEN' ? 403
        : 400;
      sendJson(response, status, { error: message, code,
        ...(error?.conflictingThreadId ? { conflictingThreadId: error.conflictingThreadId } : {}) });
    }
  };
}
