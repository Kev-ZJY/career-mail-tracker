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
    analysisVersion: 'email-preview-test-v1',
  });
  const imapSource = {
    fetchMessages: async () => [{
      provider: 'netease',
      folder: 'INBOX',
      uidValidity: '77',
      uid: '9',
      messageId: '<preview-1@test>',
      receivedAt: '2026-08-12T09:00:00.000Z',
      sender: '招聘团队 <jobs@example.test>',
      subject: '示例科技面试邀请',
      text: '公司：示例科技\n职位：后端开发工程师\n请参加面试。',
      html: '<div><p>亲爱的候选人</p><p>请参加面试。</p></div>',
      webUrl: 'https://email.163.com/',
    }],
  };
  const createClassifier = async () => ({
    classify: async () => cannedAnalysis,
  });
  const handler = createApi({
    config: { port: 0, analysisVersion: 'email-preview-test-v1' },
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
  return { baseUrl: `http://127.0.0.1:${port}`, repository };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('synced messages keep their original bodies for preview', async () => {
  const fixture = await startFixture();
  await request(fixture.baseUrl, '/api/settings/mailbox', {
    method: 'POST',
    body: { provider: 'netease', email: 'candidate@163.com', authorizationCode: 'auth-code' },
  });
  await request(fixture.baseUrl, '/api/sync/run', {
    method: 'POST',
    body: { source: 'imap', accountId: 'preview-account', from: '2026-08-12', to: '2026-08-12' },
  });

  const dashboard = await request(fixture.baseUrl, '/api/dashboard');
  assert.equal(dashboard.body.recent.length, 1);
  const row = dashboard.body.recent[0];

  const email = await request(fixture.baseUrl, `/api/progress/${row.id}/email`);
  assert.equal(email.status, 200);
  assert.equal(email.body.sender, '招聘团队 <jobs@example.test>');
  assert.equal(email.body.subject, '示例科技面试邀请');
  assert.match(email.body.bodyText, /请参加面试/);
  assert.match(email.body.bodyHtml, /<p>亲爱的候选人<\/p>/);

  const missing = await request(fixture.baseUrl, '/api/progress/99999/email');
  assert.equal(missing.status, 404);
});

test('manual progress rows have no email body and return 404', async () => {
  const fixture = await startFixture();
  const manual = await request(fixture.baseUrl, '/api/progress/manual', {
    method: 'POST',
    body: {
      company: '示例科技',
      position: '后端开发工程师',
      status: '面试',
      receivedAt: '2026-08-12T09:00:00.000Z',
      evidence: '手动记录',
    },
  });
  assert.equal(manual.status, 200);
  const email = await request(fixture.baseUrl, `/api/progress/${manual.body.id}/email`);
  assert.equal(email.status, 404);
});
