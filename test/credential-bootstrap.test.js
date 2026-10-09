import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { bootstrapCredentials } from '../src/services/credential-bootstrap.js';

function fixture({ withEmail = true, withKey = true, withAuth = true } = {}) {
  const secretsDir = mkdtempSync(join(tmpdir(), 'secrets-'));
  if (withEmail) writeFileSync(join(secretsDir, 'mailbox-email.txt'), 'candidate@163.com\n');
  if (withKey) writeFileSync(join(secretsDir, 'openrouter-api-key.txt'), 'sk-or-test-key\n');
  if (withAuth) writeFileSync(join(secretsDir, 'mailbox-netease-auth.txt'), 'netease-auth-code\n');
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const credentialStore = createCredentialStore();
  const settingsService = createSettingsService({ repository, credentialStore });
  return { repository, credentialStore, settingsService, secretsDir, close: () => database.close() };
}

test('bootstrap loads secrets into the in-memory credential store and links profiles', async () => {
  const fx = fixture();
  try {
    await bootstrapCredentials({ repository: fx.repository, credentialStore: fx.credentialStore, secretsDir: fx.secretsDir });
    const settings = fx.settingsService.getSettings();
    const openrouter = settings.providers.find((provider) => provider.id === 'openrouter');
    assert.equal(openrouter.credentialConfigured, true);
    assert.equal(settings.mailbox.email, 'candidate@163.com');
    assert.equal(settings.mailbox.credentialConfigured, true);
    assert.equal(fx.settingsService.getActiveModel().apiKey, 'sk-or-test-key');
    assert.equal(fx.settingsService.getMailboxConnection().authorizationCode, 'netease-auth-code');
  } finally {
    fx.close();
  }
});

test('bootstrap is idempotent across repeated calls', async () => {
  const fx = fixture();
  try {
    const args = { repository: fx.repository, credentialStore: fx.credentialStore, secretsDir: fx.secretsDir };
    await bootstrapCredentials(args);
    const firstProviderRef = fx.repository.getSetting('model.providers').openrouter.credentialRef;
    const firstMailboxRef = fx.repository.getSetting('mailbox.account').credentialRef;
    await bootstrapCredentials(args);
    assert.equal(fx.repository.getSetting('model.providers').openrouter.credentialRef, firstProviderRef);
    assert.equal(fx.repository.getSetting('mailbox.account').credentialRef, firstMailboxRef);
  } finally {
    fx.close();
  }
});

test('bootstrap tolerates a missing or empty secrets directory without throwing', async () => {
  const fx = fixture();
  try {
    await bootstrapCredentials({ repository: fx.repository, credentialStore: fx.credentialStore, secretsDir: join(fx.secretsDir, 'does-not-exist') });
    const settings = fx.settingsService.getSettings();
    assert.equal(settings.providers.find((provider) => provider.id === 'openrouter').credentialConfigured, false);
  } finally {
    fx.close();
  }
});

test('bootstrap never overrides an activeId the user has already chosen', async () => {
  const fx = fixture();
  try {
    // 用户已手动选择 deepseek（即使 openrouter key 也在），启动时不得顶掉
    fx.repository.saveSetting('model.activeId', 'deepseek');
    await bootstrapCredentials({ repository: fx.repository, credentialStore: fx.credentialStore, secretsDir: fx.secretsDir });
    assert.equal(fx.repository.getSetting('model.activeId'), 'deepseek');
  } finally {
    fx.close();
  }
});

test('bootstrap picks a default activeId only on first run', async () => {
  const fx = fixture();
  try {
    const args = { repository: fx.repository, credentialStore: fx.credentialStore, secretsDir: fx.secretsDir };
    await bootstrapCredentials(args);
    assert.equal(fx.repository.getSetting('model.activeId'), 'openrouter');
  } finally {
    fx.close();
  }
});
