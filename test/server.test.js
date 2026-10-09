import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

let running;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

test('server serves the tracker shell and dashboard endpoint', async () => {
  running = await startServer({
    config: { host: '127.0.0.1', port: 0, dataDir: 'data', analysisVersion: 'phase-1-demo-v1' },
    databasePath: ':memory:',
  });

  const page = await fetch(`${running.url}/`);
  const dashboard = await fetch(`${running.url}/api/dashboard`);
  const health = await fetch(`${running.url}/api/health`);

  assert.equal(page.status, 200);
  assert.match(await page.text(), /Career Mail Tracker/);
  assert.equal(dashboard.status, 200);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, analysisVersion: 'phase-1-demo-v1' });
});

test('server rejects path traversal and unknown API routes', async () => {
  running = await startServer({
    config: { host: '127.0.0.1', port: 0, dataDir: 'data', analysisVersion: 'phase-1-demo-v1' },
    databasePath: ':memory:',
  });

  const traversal = await fetch(`${running.url}/../package.json`);
  const unknown = await fetch(`${running.url}/api/not-a-route`);
  assert.equal(traversal.status, 404);
  assert.equal(unknown.status, 404);
});
