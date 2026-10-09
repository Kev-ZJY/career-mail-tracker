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

async function startFixture() {
  database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const credentialStore = createCredentialStore();
  const settingsService = createSettingsService({ repository, credentialStore });
  const syncService = createSyncService({
    repository,
    analysisVersion: 'phase-2-test-v1',
  });
  let sourceOptions;
  const imapSource = {
    fetchMessages: async (options) => {
      sourceOptions = options;
      return [{
        provider: 'qq',
        folder: 'INBOX',
        uidValidity: '77',
        uid: '9',
        messageId: '<backend-1@test>',
        receivedAt: '2026-08-12T09:00:00.000Z',
        sender: '招聘团队 <jobs@example.test>',
        subject: '示例科技面试邀请',
        text: '公司：示例科技\n职位：后端开发工程师\n请参加面试。',
        webUrl: 'https://mail.qq.com/',
      }];
    },
  };
  // Provide a mock classifier that simulates successful LLM analysis for IMAP tests
  const createClassifier = async () => ({
    classify: async () => cannedAnalysis,
  });
  const handler = createApi({
    config: { port: 0, analysisVersion: 'phase-2-test-v1' },
    repository,
    credentialStore,
    settingsService,
    syncService,
    imapSource,
    createClassifier,
  });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, getSourceOptions: () => sourceOptions };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('IMAP sync uses the configured mailbox source and records a redacted sync run', async () => {
  const fixture = await startFixture();
  await request(fixture.baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'authorization-code' },
  });

  const result = await request(fixture.baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'imap', from: '2026-08-01', to: '2026-08-31' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'imap');
  assert.equal(result.body.analyzed, 1);
  assert.equal(JSON.stringify(result.body).includes('authorization-code'), false);
  assert.equal(fixture.getSourceOptions().email, 'candidate@qq.com');
  assert.equal(fixture.getSourceOptions().authorizationCode, 'authorization-code');

  const runs = await request(fixture.baseUrl, '/api/sync/runs');
  assert.equal(runs.status, 200);
  assert.equal(runs.body[0].source, 'imap');
  assert.equal(runs.body[0].accountId, 'candidate@qq.com');
});

test('sync defaults to IMAP after a mailbox is configured', async () => {
  const fixture = await startFixture();
  await request(fixture.baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'netease', email: 'candidate@163.com', authorizationCode: 'authorization-code' },
  });

  const result = await request(fixture.baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { from: '2026-08-01', to: '2026-08-31' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'imap');
  assert.equal(fixture.getSourceOptions().provider, 'netease');
});

test('date-only sync windows use Shanghai natural-day boundaries', async () => {
  const fixture = await startFixture();
  await request(fixture.baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'netease', email: 'candidate@163.com', authorizationCode: 'authorization-code' },
  });

  const result = await request(fixture.baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'imap', from: '2026-06-05', to: '2026-06-05', dryRun: true },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.from, '2026-06-04T16:00:00.000Z');
  assert.equal(result.body.to, '2026-06-05T15:59:59.999Z');
  assert.equal(fixture.getSourceOptions().from, '2026-06-04T16:00:00.000Z');
  assert.equal(fixture.getSourceOptions().to, '2026-06-05T15:59:59.999Z');
});

test('IMAP dry run returns triage counts without analyzing or persisting messages', async () => {
  const fixture = await startFixture();
  await request(fixture.baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'qq', email: 'candidate@qq.com', authorizationCode: 'authorization-code' },
  });

  const result = await request(fixture.baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'imap', from: '2026-08-01', to: '2026-08-31', dryRun: true, maxMessages: 10 },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.equal(result.body.analyzed, 0);
  assert.equal(result.body.candidates, 1);
  const runs = await request(fixture.baseUrl, '/api/sync/runs');
  assert.equal(runs.body.length, 0);
});
