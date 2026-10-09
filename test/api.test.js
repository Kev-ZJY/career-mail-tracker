import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { createSyncService } from '../src/services/sync-service.js';

let database;
let server;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  database?.close();
  server = undefined;
  database = undefined;
});

// 模拟 LLM 的确定性分析结果（不回退原则下，sync 必须拿到注入的分类器才能工作）
const cannedAnalysis = {
  isJobRelated: true,
  company: '示例科技',
  position: '后端开发工程师',
  status: '面试',
  confidence: 0.9,
  evidence: '邀请你参加技术面试',
  nextAction: '确认面试时间',
  needsReview: false,
};

function fakeImapSource() {
  return {
    fetchMessages: async () => [{
      provider: 'qq',
      folder: 'INBOX',
      uidValidity: '77',
      uid: '9',
      messageId: '<api-1@test>',
      receivedAt: '2026-08-12T09:00:00.000Z',
      sender: '招聘团队 <jobs@example.test>',
      subject: '示例科技面试邀请',
      text: '公司：示例科技\n职位：后端开发工程师\n请参加面试。',
      webUrl: 'https://mail.qq.com/',
    }],
  };
}

async function startFixture({ withMailbox = false, withModel = true, classify, checkConnection, syncTimeouts } = {}) {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const credentialStore = createCredentialStore();
  const settingsService = createSettingsService({ repository, credentialStore });
  const syncService = createSyncService({
    repository,
    analysisVersion: 'phase-9-api-test-v1',
  });
  if (withMailbox) {
    settingsService.saveMailbox({ provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'auth-code' });
  }
  const config = { port: 0, analysisVersion: 'phase-9-api-test-v1', syncTimeouts };
  const handler = createApi({
    config,
    repository,
    credentialStore,
    settingsService,
    syncService,
    imapSource: fakeImapSource(),
    createClassifier: withModel ? async () => ({ classify: classify || (async () => cannedAnalysis), checkConnection }) : async () => null,
  });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // CSRF 允许的 Origin 依据 config.port 构造，端口 0 随机分配后回填真实端口
  config.port = server.address().port;
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, port, repository };
}

test('testing a model uses the configured provider without syncing mail or exposing credentials', async () => {
  let probes = 0;
  const f = await startFixture({ checkConnection: async () => { probes += 1; return { ok: true }; } });
  const result = await request(f.baseUrl, '/api/model/test', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.providerId, 'openrouter');
  assert.equal(probes, 1);
  assert.equal(f.repository.listThreads().length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /apiKey|credential/);
});

test('model tests report unavailable endpoints and bound an unresponsive probe', async () => {
  const f = await startFixture({ checkConnection: async () => { throw Object.assign(new Error('模型不可用（404）'), { code: 'MODEL_NOT_FOUND' }); } });
  const missing = await request(f.baseUrl, '/api/model/test', { method: 'POST' });
  assert.equal(missing.status, 502);
  assert.equal(missing.body.code, 'MODEL_NOT_FOUND');
});

test('model tests bound a probe that ignores cancellation', async () => {
  const f = await startFixture({ checkConnection: async () => new Promise(() => {}), syncTimeouts: { preflightMs: 20 } });
  const result = await request(f.baseUrl, '/api/model/test', { method: 'POST' });
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'MODEL_PREFLIGHT_TIMEOUT');
});

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('provider API never returns or persists the API key', async () => {
  const { baseUrl } = await startFixture();
  const response = await request(baseUrl, '/api/settings/provider', {
    method: 'POST',
    body: {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'secret-key',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.credentialConfigured, true);
  assert.equal(JSON.stringify(response.body).includes('secret-key'), false);
  const storedSettings = database.db.prepare('SELECT value FROM settings').all();
  assert.equal(JSON.stringify(storedSettings).includes('secret-key'), false);
});

test('mailbox API accepts QQ configuration without returning its authorization code', async () => {
  const { baseUrl } = await startFixture();
  const response = await request(baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'auth-code' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.provider, 'qq');
  assert.equal(response.body.email, 'candidate@qq.com');
  assert.equal(response.body.credentialConfigured, true);
  assert.equal(JSON.stringify(response.body).includes('auth-code'), false);
});

test('sync API analyzes fetched mail and dashboard reports analyzed statuses', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  const response = await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });
  const dashboard = await request(baseUrl, '/api/dashboard');

  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'imap');
  assert.equal(response.body.analyzed, 1);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.total, 1);
  assert.equal(Array.isArray(dashboard.body.recent), true);
});

test('demo source is rejected: the tracker only syncs real mailboxes', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  const response = await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'demo', from: '2026-08-01', to: '2026-08-31' },
  });

  assert.equal(response.status, 400);
});

test('sync without a configured model returns 503 MODEL_UNAVAILABLE', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true, withModel: false });
  const response = await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'MODEL_UNAVAILABLE');
});

test('auto sync rewinds its watermark to retry a model failure on the next run', async () => {
  let shouldFail = true;
  const { baseUrl, repository } = await startFixture({
    withMailbox: true,
    classify: async () => {
      // 消息里带 URL query 与凭据形态，用来验证 failures 返回给前端前已脱敏。
      if (shouldFail) throw new TypeError('provider timeout calling https://api.example.com/v1/chat?token=supersecret Bearer sk-abcdef1234567890');
      return cannedAnalysis;
    },
  });
  repository.saveSetting('sync.watermark.candidate@qq.com', '2026-08-01T00:00:00.000Z');

  const failed = await request(baseUrl, '/api/sync/run', { method: 'POST', body: { auto: true } });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.modelFailed, 1);
  // failures 会原样返回给前端，所以：
  //   1) 逐字段断言，不 deepEqual 整个对象（记录会随诊断需要加字段）
  //   2) 错误消息保留可诊断的措辞，但 URL query 与凭据不能漏到 UI 上
  assert.equal(failed.body.failures.length, 1);
  assert.equal(failed.body.failures[0].receivedAt, '2026-08-12T09:00:00.000Z');
  assert.equal(failed.body.failures[0].subject, '示例科技面试邀请');
  assert.equal(failed.body.failures[0].error, 'TypeError');
  assert.match(failed.body.failures[0].message, /provider timeout/, '诊断措辞要保留');
  assert.match(failed.body.failures[0].message, /api\.example\.com/, '保留 origin 够定位上游');
  assert.doesNotMatch(JSON.stringify(failed.body.failures), /supersecret/, 'query 里的 token 不能漏');
  assert.doesNotMatch(JSON.stringify(failed.body.failures), /sk-abcdef1234567890/, '凭据不能漏');
  assert.equal(repository.getSetting('sync.watermark.candidate@qq.com'), '2026-08-12T08:59:59.999Z');

  shouldFail = false;
  const retried = await request(baseUrl, '/api/sync/run', { method: 'POST', body: { auto: true } });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.analyzed, 1);
  assert.equal(retried.body.modelFailed, 0);
});

test('sync without a configured mailbox returns 502 with MAILBOX_CONFIG code', async () => {
  const { baseUrl } = await startFixture();
  const response = await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'imap', from: '2026-08-01', to: '2026-08-31' },
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'MAILBOX_CONFIG');
});

test('manual progress can be added and selected rows can be deleted in batch', async () => {
  const { baseUrl } = await startFixture();
  const added = await request(baseUrl, '/api/progress/manual', {
    method: 'POST',
    body: {
      company: '手动修正公司',
      position: '产品经理',
      status: '面试',
      receivedAt: '2026-08-20T10:00:00.000Z',
      evidence: '用户手动确认已完成一面',
      nextAction: '准备业务面试',
    },
  });

  assert.equal(added.status, 200);
  assert.equal(added.body.company, '手动修正公司');
  assert.equal(added.body.source, 'manual');
  assert.equal(typeof added.body.id, 'number');

  const filtered = await request(baseUrl, '/api/dashboard?from=2026-08-20T00:00:00.000Z&to=2026-08-20T23:59:59.999Z');
  assert.equal(filtered.body.total, 1);

  const deleted = await request(baseUrl, '/api/progress/delete', {
    method: 'POST',
    body: { ids: [added.body.id] },
  });
  assert.deepEqual(deleted.body, { deleted: 1 });

  const afterDelete = await request(baseUrl, '/api/dashboard');
  assert.equal(afterDelete.body.total, 0);
});

test('dashboard serves aggregated application threads after a sync', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });
  const dashboard = await request(baseUrl, '/api/dashboard');

  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.total, dashboard.body.recent.length);
  for (const row of dashboard.body.recent) {
    assert.equal(typeof row.id, 'number');
    assert.equal(typeof row.company, 'string');
    assert.equal(typeof row.status, 'string');
    assert.equal(typeof row.latestReceivedAt, 'string');
    if (row.source === 'email') assert.equal(typeof row.latestMessageId, 'number');
  }
  assert.equal(Object.keys(dashboard.body.counts).length > 0, true);
});

test('editing and deleting progress operates on threads and keeps the mail archive', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });
  const dashboard = await request(baseUrl, '/api/dashboard');
  const target = dashboard.body.recent[0];

  const updated = await request(baseUrl, `/api/progress/${target.id}`, {
    method: 'PUT',
    body: {
      company: target.company,
      position: target.position,
      status: 'Offer',
      eventStart: target.latestReceivedAt,
      notes: '手动推进到 Offer',
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'Offer');
  assert.equal(updated.body.notes, '');

  const messageCountBefore = database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count;
  assert.equal(messageCountBefore > 0, true);
  const deleted = await request(baseUrl, '/api/progress/delete', {
    method: 'POST',
    body: { ids: [target.id] },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, 1);
  const messageCountAfter = database.db.prepare('SELECT COUNT(*) AS count FROM mail_messages').get().count;
  assert.equal(messageCountAfter, messageCountBefore);
  const afterDelete = await request(baseUrl, '/api/dashboard');
  assert.equal(afterDelete.body.total, dashboard.body.total - 1);
});

test('manual progress API enforces the status-based notes whitelist', async () => {
  const { baseUrl } = await startFixture({ withMailbox: false });
  const created = await request(baseUrl, '/api/progress/manual', {
    method: 'POST',
    body: {
      company: '示例公司',
      position: '产品经理',
      status: '已投递',
      eventStart: '2026-09-11T02:00:00.000Z',
      notes: '岗位未识别；感谢投递',
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.notes, '');

  const assessment = await request(baseUrl, `/api/progress/${created.body.id}`, {
    method: 'PUT',
    body: {
      company: '示例公司',
      position: '产品经理',
      status: '测评中',
      eventStart: '2026-09-11T02:00:00.000Z',
      eventEnd: '2026-09-12T15:59:00.000Z',
      notes: '邮件原文；测评链接：https://assessment.example.test/manual；岗位未识别',
    },
  });
  assert.equal(assessment.status, 200);
  assert.equal(assessment.body.notes, '测评链接：https://assessment.example.test/manual；测评截止时间：2026-09-12 23:59');

  const interview = await request(baseUrl, `/api/progress/${created.body.id}`, {
    method: 'PUT',
    body: {
      company: '示例公司',
      position: '产品经理',
      status: '面试',
      eventStart: '2026-09-13T02:00:00.000Z',
      notes: '面试链接：https://meeting.example.test/room；下载链接：https://download.example.test/app',
    },
  });
  assert.equal(interview.status, 200);
  assert.equal(interview.body.notes, '面试链接：https://meeting.example.test/room');
});

test('editing an email-derived application to a different position records a manual position override', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  await request(baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });
  const target = (await request(baseUrl, '/api/dashboard')).body.recent[0];

  const updated = await request(baseUrl, `/api/progress/${target.id}`, {
    method: 'PUT',
    body: {
      company: target.company,
      position: '用户产品经理',
      status: target.status,
      eventStart: target.latestReceivedAt,
      notes: '岗位由用户核对后修正',
    },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.position, '用户产品经理');
  assert.equal(updated.body.manualPositionOverride, true);
  assert.equal(updated.body.source, 'email');
});

test('mutating endpoints reject non-JSON content types (CSRF guard)', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  const response = await fetch(`${baseUrl}/api/progress/delete`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ ids: [1, 2, 3] }),
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'FORBIDDEN');
});

test('mutating endpoints reject cross-origin requests (CSRF guard)', async () => {
  const { baseUrl } = await startFixture({ withMailbox: true });
  const response = await request(baseUrl, '/api/progress/delete', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: { ids: [1, 2, 3] },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'FORBIDDEN');
});

test('mutating endpoints accept same-origin requests', async () => {
  const { baseUrl, port } = await startFixture({ withMailbox: true });
  const response = await request(baseUrl, '/api/progress/manual', {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}` },
    body: {
      company: '示例科技',
      position: '产品经理',
      status: '面试',
      receivedAt: '2026-08-20T10:00:00.000Z',
      evidence: '手动记录',
    },
  });

  assert.equal(response.status, 200);
});
