import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalRules } from '../src/rules-config.js';

test('missing local rules are optional', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-mail-rules-'));
  assert.deepEqual(await loadLocalRules(join(root, 'missing.toml')), { companyAliases: {} });
});

test('local rules load only explicit company aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-mail-rules-'));
  const file = join(root, 'rules.toml');
  await writeFile(file, '[company_aliases]\n"Example Technology Ltd." = "示例科技"\n"示例科技有限公司" = "示例科技"\n', 'utf8');
  assert.deepEqual(await loadLocalRules(file), {
    companyAliases: {
      'Example Technology Ltd.': '示例科技',
      '示例科技有限公司': '示例科技',
    },
  });
});

test('unsupported sections fail instead of creating hidden mail-template behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-mail-rules-'));
  const file = join(root, 'rules.toml');
  await writeFile(file, '[position_templates]\n"subject" = "position"\n', 'utf8');
  await assert.rejects(() => loadLocalRules(file), /unsupported rules section/);
});
