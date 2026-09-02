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

async function startFixture({ withMailbox = false, withModel = true } = {}) {
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
  const config = { port: 0, analysisVersion: 'phase-9-api-test-v1' };
  const handler = createApi({
    config,
    repository,
    credentialStore,
    settingsService,
    syncService,
    imapSource: fakeImapSource(),
    createClassifier: withModel ? async () => ({ classify: async () => cannedAnalysis }) : async () => null,
  });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // CSRF 允许的 Origin 依据 config.port 构造，端口 0 随机分配后回填真实端口
  config.port = server.address().port;
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, port, repository };
}

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
