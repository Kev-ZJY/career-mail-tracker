import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';

test('createConfig uses local-only defaults and a stable analysis version', () => {
  const config = createConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4317);
  assert.equal(config.dataDir, 'data');
  assert.equal(config.rulesFile, 'data/rules.toml');
  assert.equal(config.analysisVersion, 'generic-mail-extraction-v7');
});

test('createConfig accepts explicit port and data directory', () => {
  const config = createConfig({ PORT: '4800', DATA_DIR: './runtime-data' });
  assert.equal(config.port, 4800);
  assert.equal(config.dataDir, './runtime-data');
  assert.equal(config.rulesFile, './runtime-data/rules.toml');
});

test('mail analysis has a shared 90-second default while other workflow deadlines stay unchanged', () => {
  assert.deepEqual(createConfig({}).syncTimeouts, {
    connectMs: 15_000,
    lockMs: 10_000,
    searchMs: 10_000,
    fetchMs: 20_000,
    parseMs: 5_000,
    logoutMs: 2_000,
    preflightMs: 8_000,
    modelMs: 90_000,
    messageMs: 90_000,
    runMs: 180_000,
  });
});

test('explicit analysis timeout environment values override defaults and invalid values fall back', () => {
  const explicit = createConfig({ SYNC_MODEL_TIMEOUT_MS: '70000', SYNC_MESSAGE_TIMEOUT_MS: '95000' });
  assert.equal(explicit.syncTimeouts.modelMs, 70_000);
  assert.equal(explicit.syncTimeouts.messageMs, 95_000);
  const invalid = createConfig({ SYNC_MODEL_TIMEOUT_MS: '0', SYNC_MESSAGE_TIMEOUT_MS: 'bad' });
  assert.equal(invalid.syncTimeouts.modelMs, 90_000);
  assert.equal(invalid.syncTimeouts.messageMs, 90_000);
});
