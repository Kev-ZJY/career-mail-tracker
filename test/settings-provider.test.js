import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMessageRepository } from '../src/db.js';
import { createCredentialStore } from '../src/services/credential-store.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { isReasoningOnly, resolveMaxTokens } from '../src/services/model-capabilities.js';

function buildService() {
  const database = createDatabase(':memory:');
  const repository = createMessageRepository(database.db);
  const service = createSettingsService({
    repository,
    credentialStore: createCredentialStore(),
  });
  return { service, repository, close: () => database.close() };
}

test('openrouter is a built-in provider listed first', () => {
  const { service, close } = buildService();
  const settings = service.getSettings();
  const openrouter = settings.providers.find((provider) => provider.id === 'openrouter');
  assert.ok(openrouter, 'openrouter provider missing');
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(openrouter.credentialConfigured, false);
  assert.equal(settings.providers[0].id, 'openrouter');
  close();
});

test('getActiveModel defaults to openrouter when nothing is saved', () => {
  const { service, close } = buildService();
  const model = service.getActiveModel();
  assert.equal(model.id, 'openrouter');
  assert.equal(model.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(model.baseUrl, 'https://openrouter.ai/api/v1');
  // Built-in defaults and saved overrides use the same public and runtime profile.
  assert.equal(isReasoningOnly(model), false);
  assert.equal(resolveMaxTokens(model), 700);
  close();
});

test('saved model names are preserved even when they match an old default', () => {
  const { service, repository, close } = buildService();
  repository.saveSetting('model.providers', {
    openrouter: { model: 'nvidia/nemotron-3.5-lightning:free', credentialRef: 'memory-credential-1' },
  });
  const model = service.getActiveModel();
  assert.equal(model.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(model.credentialRef, 'memory-credential-1');
  assert.equal(service.getSettings().providers[0].model, model.model);
  close();
});

test('a model the user chose is never treated as a retired default', () => {
  const { service, repository, close } = buildService();
  repository.saveSetting('model.providers', {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      protocol: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'some-org/some-model-i-picked',
      credentialRequired: true,
      credentialRef: 'memory-credential-1',
    },
  });
  repository.saveSetting('model.activeId', 'openrouter');

  assert.equal(service.getActiveModel().model, 'some-org/some-model-i-picked');
  assert.equal(
    service.getSettings().providers.find((provider) => provider.id === 'openrouter').model,
    'some-org/some-model-i-picked',
  );
  close();
});

test('reasoning capability follows the model, not the provider slot', () => {
  const { service, close } = buildService();
  // 用户在设置页把 openrouter 换成普通模型：能力判定必须跟着模型走，
  // 不能因为默认值里曾经是 reasoning 模型就误判。
  service.saveProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'some-org/some-plain-model',
    apiKey: 'sk-test',
  });
  const model = service.getActiveModel();
  assert.equal(model.model, 'some-org/some-plain-model');
  assert.equal(isReasoningOnly(model), false);
  assert.equal(resolveMaxTokens(model), 700);
  close();
});

test('settings expose the active provider and normalize a pasted completion endpoint', () => {
  const { service, close } = buildService();
  service.saveProvider({ id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/chat/completions/', apiKey: 'fixture-key' });
  assert.equal(service.getSettings().activeProviderId, 'deepseek');
  assert.equal(service.getActiveModel().baseUrl, 'https://api.deepseek.com');
  service.saveProvider({ id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: '' });
  assert.equal(service.getActiveModel().apiKey, 'fixture-key');
  close();
});

test('invalid model URLs cannot replace the saved configuration', () => {
  const { service, close } = buildService();
  for (const baseUrl of ['invalid', 'ftp://model.test', 'https://user:secret@model.test', 'https://model.test?key=secret']) {
    assert.throws(() => service.saveProvider({ id: 'deepseek', name: 'DeepSeek', model: 'test', baseUrl }), (error) => error.code === 'MODEL_CONFIG_INVALID');
  }
  assert.equal(service.getSettings().activeProviderId, 'openrouter');
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
