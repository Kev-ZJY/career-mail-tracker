import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressHistory } from '../public/application-organization-ui.js';

class Node {
  constructor(tagName) { this.tagName = tagName; this.childNodes = []; this.attributes = {}; this.handlers = {}; this.textContent = ''; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = [...nodes]; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}
function nodes(root) { return [root, ...root.childNodes.flatMap(nodes)]; }
function withDocument(run) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tagName) => new Node(tagName) };
  try { run(); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}

test('unified history marks only true records without mail as manual records', () => withDocument(() => {
  const target = new Node('div');
  renderProgressHistory(target, [
    { id: 'email:1', kind: 'email', status: '面试', manualPositionOverride: true, messages: [{ id: 1, subject: '面试邀请' }] },
    { id: 'manual:2', kind: 'manual', status: '面试', recordedAt: '2030-01-01', messageIds: [], messages: [] },
  ]);
  const rendered = nodes(target);
  assert.equal(rendered.filter((node) => node.textContent === '手动记录').length, 1);
  assert.equal(rendered.filter((node) => node.textContent === '面试邀请').length, 1);
  assert.ok(!rendered.some((node) => /人工修正|手动历史|email:1|manual:2/.test(node.textContent)));
}));

test('one selected progress carries several visible mails and each opens the correct current owner', () => withDocument(() => {
  const target = new Node('div');
  const opened = [];
  renderProgressHistory(target, [{ id: 'email:21', kind: 'email', threadId: 4, company: '示例出行', position: '产品', status: '已结束', messageIds: [21, 22], messages: [{ id: 21, subject: '招聘回复一' }, { id: 22, subject: '招聘回复二' }] }], {
    selectable: true, thread: { id: 8, company: '示例出行', position: '航线' }, openEmail: (thread, messageId) => opened.push([thread.id, thread.position, messageId]),
  });
  const rendered = nodes(target);
  const checkbox = rendered.find((node) => node.tagName === 'input');
  assert.equal(checkbox.value, 'email:21');
  assert.match(checkbox.attributes['aria-label'], /招聘回复一/);
  assert.match(checkbox.attributes['aria-label'], /招聘回复二/);
  assert.equal(rendered.find((node) => node.className === 'progress-history-mail-count').textContent, '相关邮件 · 2 封');
  for (const button of rendered.filter((node) => node.tagName === 'button')) button.handlers.click();
  assert.deepEqual(opened, [[4, '产品', 21], [4, '产品', 22]]);
}));
