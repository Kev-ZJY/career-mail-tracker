import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';

function buildService() {
  const database = createDatabase(':memory:');
  const service = createSettingsService({
    repository: createMessageRepository(database.db),
    credentialStore: createCredentialStore(),
  });
  return { service, close: () => database.close() };
}

test('openrouter is a built-in provider listed first', () => {
  const { service, close } = buildService();
  const settings = service.getSettings();
  const openrouter = settings.providers.find((provider) => provider.id === 'openrouter');
  assert.ok(openrouter, 'openrouter provider missing');
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(openrouter.credentialConfigured, false);
  assert.equal(settings.providers[0].id, 'openrouter');
  close();
});

test('getActiveModel defaults to openrouter when nothing is saved', () => {
  const { service, close } = buildService();
  const model = service.getActiveModel();
  assert.equal(model.id, 'openrouter');
  assert.equal(model.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(model.baseUrl, 'https://openrouter.ai/api/v1');
  close();
});

test('saving a provider keeps openrouter selectable alongside built-ins', () => {
  const { service, close } = buildService();
  service.saveProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
  });
  const model = service.getActiveModel();
  assert.equal(model.id, 'deepseek');
  const settings = service.getSettings();
  assert.ok(settings.providers.some((provider) => provider.id === 'openrouter'));
  close();
});
