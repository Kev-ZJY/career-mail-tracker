import test from 'node:test';
import assert from 'node:assert/strict';
import { getMailboxProvider } from '../src/mail/provider-registry.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createMailboxService } from '../src/services/mailbox-service.js';

test('mailbox service resolves QQ and NetEase IMAP endpoints without exposing credentials', async () => {
  let received;
  const service = createMailboxService({
    credentialStore: createCredentialStore(),
    providerRegistry: getMailboxProvider,
    clientFactory: (options) => ({
      options,
      connect: async () => { received = options; },
      logout: async () => {},
    }),
  });

  const result = await service.testConnection({
    provider: 'qq',
    email: 'a@qq.com',
    authorizationCode: 'secret',
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'qq');
  assert.equal(received.host, 'imap.qq.com');
  assert.equal(received.port, 993);
  assert.equal(received.auth.pass, 'secret');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('mailbox service rejects unsupported providers before opening a connection', async () => {
  let called = false;
  const service = createMailboxService({
    credentialStore: createCredentialStore(),
    providerRegistry: getMailboxProvider,
    clientFactory: () => { called = true; },
  });

  await assert.rejects(
    service.testConnection({ provider: 'gmail', email: 'a@gmail.com', authorizationCode: 'secret' }),
    /provider must be qq or netease/,
  );
  assert.equal(called, false);
});

test('mailbox diagnostics honour the same proxy, TLS identity and budgets as sync', async () => {
  let received;
  const service = createMailboxService({
    providerRegistry: () => ({ id: 'netease', host: '192.0.2.10', port: 993, secure: true, tlsServername: 'imap.163.com' }),
    env: { IMAP_PROXY: 'socks5://127.0.0.1:1080' }, timeouts: { connectMs: 50, fetchMs: 75 },
    clientFactory: (options) => { received = options; return { connect: async () => {}, logout: async () => {} }; },
  });
  assert.equal((await service.testConnection({ provider: 'netease', email: 'fixture@example.test', authorizationCode: 'fixture' })).ok, true);
  assert.equal(received.proxy, 'socks5://127.0.0.1:1080');
  assert.equal(received.tls.servername, 'imap.163.com');
  assert.equal(received.connectionTimeout, 50);
  assert.equal(received.socketTimeout, 75);
});
