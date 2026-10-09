#!/usr/bin/env node
// 检查 data/rules.toml 的公司别名表是否会因「归一化后重名」而静默失效。
//
// 为什么需要这个脚本：resolveCompanyName 匹配别名时用的是
// companyComparisonKey（会剥掉「集团/股份/有限公司」等后缀），并且要求
// 命中项恰好一条——命中 0 条不归一，命中 2 条以上判为歧义也不归一。
//
// 于是下面这种写法看起来很合理，实际却会让两条规则**同时失效**：
//   "示例科技" = "示例企业"
//   "示例科技股份有限公司" = "示例企业"     ← 归一化后 key 都是「示例科技」
//
// 失效是静默的：不报错、不告警，模型输出「示例科技」时原样落库，
// 线程按 (company, position) 聚合，同一家公司被拆成多个线程。
//
// 用法：node scripts/check-aliases.mjs [rulesPath]
// 退出码：有冲突时为 1（可直接进 CI）。
import { resolve } from 'node:path';
import { companyComparisonKey, resolveCompanyName } from '../src/domain/company-resolver.js';
import { loadLocalRules } from '../src/rules-config.js';
import { createConfig } from '../src/config.js';

const config = createConfig();
const filePath = process.argv[2] || resolve(config.dataDir, 'rules.toml');
const { companyAliases } = await loadLocalRules(filePath);

if (!Object.keys(companyAliases).length) {
  console.log(`别名表为空或不存在：${filePath}`);
  console.log('（这是允许状态——config/rules.example.toml 说产品不依赖它也能跑）');
  process.exit(0);
}

const byKey = new Map();
for (const [alias, canonical] of Object.entries(companyAliases)) {
  const key = companyComparisonKey(alias);
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push({ alias, canonical });
}

const conflicts = [...byKey.entries()].filter(([, entries]) => entries.length > 1);

console.log(`别名表：${filePath}`);
console.log(`条目：${Object.keys(companyAliases).length} 条`);

if (conflicts.length) {
  console.log(`\n❌ ${conflicts.length} 处归一化后重名（这些别名会静默失效）：\n`);
  for (const [key, entries] of conflicts) {
    console.log(`   key = ${key}`);
    for (const { alias, canonical } of entries) console.log(`     "${alias}" = "${canonical}"`);
    // 直接演示失效：模拟模型输出该 key 下任一写法，看是否真没被归一。
    const probe = entries[0].alias;
    const got = resolveCompanyName({ company: probe, openThreads: [], aliases: companyAliases });
    const worked = got === entries[0].canonical;
    console.log(`     实测 resolveCompanyName("${probe}") = "${got}" ${worked ? '' : '← 确认未归一（歧义）'}`);
    console.log('');
  }
  console.log('修法：删掉多余的条目。后缀变体（股份有限公司/有限公司/集团）');
  console.log('      会被 companyComparisonKey 自动剥离，不需要单独写一条。');
  process.exit(1);
}

console.log('\n✅ 无归一化重名冲突');
console.log('\n逐条生效验证：');
let broken = 0;
for (const [alias, canonical] of Object.entries(companyAliases)) {
  const got = resolveCompanyName({ company: alias, openThreads: [], aliases: companyAliases });
  const ok = got === canonical;
  if (!ok) broken++;
  console.log(`   ${ok ? '✅' : '❌'} "${alias}" -> "${got}"${ok ? '' : ` (期望 "${canonical}")`}`);
}
console.log(`\n${broken === 0 ? '✅ 全部 ' + Object.keys(companyAliases).length + ' 条生效' : '❌ ' + broken + ' 条未生效'}`);
process.exit(broken === 0 ? 0 : 1);
