import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsSubmitHandler } from '../public/settings-form.js';

function fixture(options = {}) {
  const secret = { value: 'fixture-secret' };
  const button = { disabled: false };
  const form = new EventTarget();
  form.querySelector = () => secret;
  form.querySelectorAll = () => [button];
  const notices = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const handler = createSettingsSubmitHandler({
    save: async () => {}, refresh: async () => {},
    readValues: () => ({ model: 'fixture-model' }),
    notify: (...args) => notices.push(args),
    secretField: 'apiKey', successMessage: '已保存', ...options,
  });
  form.addEventListener('submit', (event) => { handler(event).finally(finish); });
  return { form, secret, button, notices, done };
}

test('settings submission survives currentTarget being cleared after dispatch', async () => {
  const f = fixture();
  const event = new Event('submit', { cancelable: true });
  f.form.dispatchEvent(event);
  assert.equal(event.currentTarget, null);
  assert.equal(f.button.disabled, true);
  await f.done;
  assert.equal(f.secret.value, '');
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.notices, [['已保存']]);
});

test('failed saves preserve the draft and restore submit controls', async () => {
  const f = fixture({ save: async () => { throw new Error('保存失败'); } });
  f.form.dispatchEvent(new Event('submit'));
  await f.done;
  assert.equal(f.secret.value, 'fixture-secret');
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.notices, [['保存失败', 'error']]);
});

test('a refresh failure after saving is reported as saved, without exposing the secret', async () => {
  const f = fixture({ refresh: async () => { throw new Error('服务无响应'); } });
  f.form.dispatchEvent(new Event('submit'));
  await f.done;
  assert.equal(f.secret.value, '');
  assert.deepEqual(f.notices, [['配置已保存，但页面刷新失败：服务无响应', 'warn']]);
});

test('duplicate submissions cannot overlap while the save is pending', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture({ save: async () => { calls += 1; await pending; } });
  f.form.dispatchEvent(new Event('submit'));
  f.form.dispatchEvent(new Event('submit'));
  release();
  await f.done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(f.button.disabled, false);
});
