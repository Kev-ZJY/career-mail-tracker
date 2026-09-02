import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';

test('createConfig uses local-only defaults and a stable analysis version', () => {
  const config = createConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4317);
  assert.equal(config.dataDir, 'data');
  assert.equal(config.analysisVersion, 'phase-9-fallback-removal-v1');
});

test('createConfig accepts explicit port and data directory', () => {
  const config = createConfig({ PORT: '4800', DATA_DIR: './runtime-data' });
  assert.equal(config.port, 4800);
  assert.equal(config.dataDir, './runtime-data');
});
