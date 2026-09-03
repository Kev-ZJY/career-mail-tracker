const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_PROGRESS_STATUSES = new Set(['已投递', '测评中', '面试', 'Offer', '已结束']);
const DATE_ONLY_OFFSET = '+08:00';
import { ApiError } from './errors.js';

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
  return async function apiHandler(request, response) {
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

      if (request.method === 'POST' && path === '/api/mailbox/test') {
        if (!mailboxService) throw new Error('IMAP mailbox service is unavailable');
        const input = await readJson(request);
        const saved = settingsService.getMailboxConnection?.();
        const result = await mailboxService.testConnection({
          provider: input.provider || saved?.provider,
          email: input.email || saved?.email,
          authorizationCode: input.authorizationCode || saved?.authorizationCode,
        });
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
        const input = await readJson(request);
        const savedMailbox = settingsService.getMailboxConnection?.();
        if (input.source && input.source !== 'imap') throw new Error('source must be imap');
        const source = 'imap';
        let accountId = typeof input.accountId === 'string' && input.accountId.trim()
          ? input.accountId.trim()
          : null;
        let from = input.from ? normalizeWindow(input.from, false) : undefined;
        let to = input.to ? normalizeWindow(input.to, true) : undefined;
        const dryRun = input.dryRun === true;
        // 不设同步上限：IMAP 协议无数量限制，窗口内全量拉取；调用方仍可显式传 maxMessages
        // 手动限制（此时取窗口内最新的 N 封，避免漏掉最新邮件）。
        const maxMessages = input.maxMessages == null
          ? undefined
          : Math.max(1, Number(input.maxMessages) || 0) || undefined;
        if (!imapSource) throw new ApiError('IMAP mailbox source is unavailable', 'MAILBOX_CONFIG');
        const mailbox = savedMailbox || settingsService.getMailboxConnection?.();
        if (!mailbox?.email || !mailbox.authorizationCode) throw new ApiError('mailbox is not configured', 'MAILBOX_CONFIG');
        if (accountId === null) accountId = mailbox.email;
        let messages;
        if (input.auto) {
          // watermark 键读写统一用 accountId，避免自定义 accountId 时读写不对称
          const watermark = repository.getSetting(`sync.watermark.${accountId}`);
          const fallbackStart = new Date(Date.now() - 30 * 86_400_000);
          const startDay = watermark ? new Date(Date.parse(watermark)).toISOString().slice(0, 10) : fallbackStart.toISOString().slice(0, 10);
          from = normalizeWindow(startDay, false);
          to = normalizeWindow(new Date().toISOString().slice(0, 10), true);
        }
        if (!from || !to) throw new Error('from and to are required');
        try {
          messages = await imapSource.fetchMessages({
            provider: mailbox.provider,
            email: mailbox.email,
            authorizationCode: mailbox.authorizationCode,
            from,
            to,
            maxMessages,
          });
        } catch (error) {
          throw new ApiError(`imap fetch failed: ${error instanceof Error ? error.message : String(error)}`, 'MAILBOX_CONFIG');
        }
        if (Date.parse(from) > Date.parse(to)) throw new Error('from must be earlier than or equal to to');
        const classifierOverride = createClassifier ? await createClassifier() : undefined;
        if (!classifierOverride) throw new ApiError('model is not configured', 'MODEL_UNAVAILABLE');
        const summary = await syncService.syncMessages({
          accountId,
          from,
          to,
          messages,
          source,
          classifierOverride,
          dryRun,
        });
        if (!dryRun) {
          repository.saveSetting(`sync.watermark.${accountId}`, to);
        }
        sendJson(response, 200, { ...summary, mode: source, accountId, from, to, dryRun, maxMessages: maxMessages ?? null });
        return;
      }

      if (request.method === 'POST' && path === '/api/progress/manual') {
        const input = await readJson(request);
        const company = typeof input.company === 'string' ? input.company.trim() : '';
        const position = typeof input.position === 'string' ? input.position.trim() : '';
        const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
        const notes = typeof input.notes === 'string' ? input.notes.trim() : evidence;
        const nextAction = typeof input.nextAction === 'string' ? input.nextAction.trim() : '由用户手动维护';
        if (!company || !position || !notes) {
          throw new Error('company, position, and notes are required');
        }
        if (!ALLOWED_PROGRESS_STATUSES.has(input.status)) throw new Error('status is invalid');
        const receivedAt = input.receivedAt || input.eventStart || new Date().toISOString();
        if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('receivedAt is invalid');
        if (input.eventEnd && (!Number.isFinite(Date.parse(input.eventEnd)) || Date.parse(input.eventEnd) < Date.parse(receivedAt))) {
          throw new Error('eventEnd is invalid');
        }
        const row = repository.addManualThread({
          company,
          position,
          status: input.status,
          receivedAt,
          evidence,
          notes,
          nextAction,
          eventStart: input.eventStart || receivedAt,
          eventEnd: input.eventEnd,
          webUrl: input.webUrl,
          confidence: 1,
        });
        sendJson(response, 200, row);
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

      const editMatch = path.match(/^\/api\/progress\/(\d+)$/);
      if (request.method === 'PUT' && editMatch) {
        const input = await readJson(request);
        const company = typeof input.company === 'string' ? input.company.trim() : '';
        const position = typeof input.position === 'string' ? input.position.trim() : '';
        const eventStart = input.eventStart || input.receivedAt;
        if (!company || !ALLOWED_PROGRESS_STATUSES.has(input.status)) throw new Error('company and status are required');
        if (!eventStart || !Number.isFinite(Date.parse(eventStart))) throw new Error('eventStart is invalid');
        if (input.eventEnd && (!Number.isFinite(Date.parse(input.eventEnd)) || Date.parse(input.eventEnd) < Date.parse(eventStart))) throw new Error('eventEnd is invalid');
        const row = repository.updateThread(Number(editMatch[1]), {
          company,
          position,
          status: input.status,
          eventStart: new Date(eventStart).toISOString(),
          eventEnd: input.eventEnd ? new Date(input.eventEnd).toISOString() : null,
          notes: typeof input.notes === 'string' ? input.notes.trim() : '',
          evidence: typeof input.evidence === 'string' ? input.evidence.trim() : '',
          nextAction: typeof input.nextAction === 'string' ? input.nextAction.trim() : '',
          needsReview: false,
        });
        if (!row) { sendJson(response, 404, { error: 'progress not found' }); return; }
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
      const message = error instanceof Error ? error.message : 'request failed';
      const code = error instanceof ApiError ? error.code : 'GENERIC';
      const status = error instanceof ApiError && error.code === 'MAILBOX_CONFIG' ? 502
        : error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE' ? 503
        : error instanceof ApiError && error.code === 'FORBIDDEN' ? 403
        : 400;
      sendJson(response, status, { error: message, code });
    }
  };
}
