import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompanyName } from '../src/domain/company-resolver.js';

test('a thread reference cannot overwrite a different non-empty company', () => {
  assert.equal(resolveCompanyName({
    company: 'Example Technology Ltd.',
    threadRef: 8,
    openThreads: [{ id: 8, company: '示例科技' }],
  }), 'Example Technology Ltd.');
});

test('an empty company may inherit the company from a valid thread reference', () => {
  assert.equal(resolveCompanyName({
    company: '',
    threadRef: 8,
    openThreads: [{ id: 8, company: '示例科技' }],
  }), '示例科技');
});

test('an explicit local alias is used without source-code company cases', () => {
  assert.equal(resolveCompanyName({
    company: 'Example Technology Ltd.',
    aliases: { 'Example Technology Ltd.': '示例科技' },
  }), '示例科技');
});

test('a generic legal suffix variation reuses one unambiguous existing name', () => {
  assert.equal(resolveCompanyName({
    company: '示例科技有限公司',
    openThreads: [{ id: 1, company: '示例科技' }, { id: 2, company: '另一家公司' }],
  }), '示例科技');
});

test('an English legal suffix variation reuses one unambiguous existing name', () => {
  assert.equal(resolveCompanyName({
    company: 'Example Technology Ltd.',
    openThreads: [{ id: 1, company: 'Example Technology', position: '工程师' }],
  }), 'Example Technology');
});

test('cross-language names are not guessed without model context or a local alias', () => {
  assert.equal(resolveCompanyName({
    company: 'Example Technology',
    openThreads: [{ id: 1, company: '示例科技' }],
  }), 'Example Technology');
});

test('ambiguous normalized candidates are not force-merged', () => {
  assert.equal(resolveCompanyName({
    company: '示例科技有限责任公司',
    openThreads: [{ id: 1, company: '示例科技有限公司' }, { id: 2, company: '示例科技股份有限公司' }],
  }), '示例科技有限责任公司');
});

test('alias keys that collide after suffix stripping are not applied', () => {
  // 别名匹配走的是 companyComparisonKey（会剥掉「股份有限公司」等后缀），
  // 命中项必须恰好一条。所以下面两条别名归一化后 key 相同 → 判为歧义 →
  // 两条都失效，模型输出的写法原样返回。
  //
  // 这不是 bug 而是防误伤设计，但它是**静默**的：不报错、不告警，
  // 使用者只会看到「我配了别名怎么没生效」。因此 data/rules.toml 的写法
  // 约束（后缀变体不要重复写）必须由 scripts/check-aliases.mjs 守住。
  const aliases = { 示例影像科技: '示例影像', 示例影像科技股份有限公司: '示例影像' };
  assert.equal(resolveCompanyName({ company: '示例影像科技', aliases }), '示例影像科技');
  assert.equal(resolveCompanyName({ company: '示例影像科技股份有限公司', aliases }), '示例影像科技股份有限公司');
});

test('a single alias still absorbs legal-suffix variations of the same company', () => {
  // 上条的反向对照：只写一条时，后缀变体靠 key 归一化被自动吸收，
  // 不需要为「XX股份有限公司」再写一条。
  const aliases = { 示例影像科技: '示例影像' };
  assert.equal(resolveCompanyName({ company: '示例影像科技', aliases }), '示例影像');
  assert.equal(resolveCompanyName({ company: '示例影像科技股份有限公司', aliases }), '示例影像');
});

test('an alias is idempotent once the canonical name is already stored', () => {
  // 重复同步同一封邮件时，输入已经是标准名，别名不能再改写它。
  const aliases = { 示例物流: '示例物流集团', ExampleInternet: '示例互联' };
  assert.equal(resolveCompanyName({ company: '示例物流集团', aliases }), '示例物流集团');
  assert.equal(resolveCompanyName({ company: '示例互联', aliases }), '示例互联');
});
