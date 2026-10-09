import test from 'node:test';
import assert from 'node:assert/strict';
import { isReasoningOnly, resolveMaxTokens } from '../src/services/model-capabilities.js';

test('reasoning-only model is recognized and gets a large token budget', () => {
  const provider = { id: 'openrouter', model: 'stealth/space-bunny-alpha' };
  assert.equal(isReasoningOnly(provider), true);
  assert.equal(resolveMaxTokens(provider), 4000);
});

test('ordinary openrouter model keeps reasoning disabled and the small budget', () => {
  const provider = { id: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' };
  assert.equal(isReasoningOnly(provider), false);
  assert.equal(resolveMaxTokens(provider), 700);
});

test('non-openrouter models are not affected by the openrouter model table', () => {
  const provider = { id: 'deepseek', model: 'deepseek-chat' };
  assert.equal(isReasoningOnly(provider), false);
  assert.equal(resolveMaxTokens(provider), 700);
});

test('explicit reasoningEnabled overrides the model table in both directions', () => {
  // 自定义端点显式声明强制 reasoning。
  assert.equal(isReasoningOnly({ model: 'some/custom-model', reasoningEnabled: true }), true);
  assert.equal(resolveMaxTokens({ model: 'some/custom-model', reasoningEnabled: true }), 4000);
  // 显式声明关闭时，模型表不能反过来把它打开。
  assert.equal(isReasoningOnly({ model: 'stealth/space-bunny-alpha', reasoningEnabled: false }), false);
});

test('an explicit maxTokens is honoured for non-reasoning models', () => {
  assert.equal(resolveMaxTokens({ model: 'some/model', maxTokens: 1200 }), 1200);
  // reasoning-only 的预算是硬下限，provider.maxTokens 不能把它压回去。
  assert.equal(resolveMaxTokens({ model: 'stealth/space-bunny-alpha', maxTokens: 100 }), 4000);
});

test('missing or malformed model fields do not throw', () => {
  for (const provider of [{}, { model: '' }, { model: null }, { model: undefined }]) {
    assert.equal(isReasoningOnly(provider), false);
    assert.equal(resolveMaxTokens(provider), 700);
  }
});
