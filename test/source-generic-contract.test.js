import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function javascriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await javascriptFiles(path));
    else if (entry.isFile() && path.endsWith('.js')) result.push(path);
  }
  return result;
}

test('product source has no sample-company mappings, mail templates, or goldenset version labels', async () => {
  const files = await javascriptFiles(fileURLToPath(new URL('../src', import.meta.url)));
  const prohibited = [
    '示例影像', 'ExampleCommerce', '示例商城', 'ExampleConsulting', '示例网络音乐', '示例作业科技', 'EXAMPLE_FLIGHT', '示例飞行科技',
    '示例旅行', '示例设计研究所', 'ExampleAudio', '示例声学', '示例信息科技', '示例出行',
    '示例社区', '示例日化', '示例交通', 'goldenset',
  ];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const value of prohibited) {
      if (source.includes(value)) violations.push(`${file}: ${value}`);
    }
  }
  assert.deepEqual(violations, []);
});
