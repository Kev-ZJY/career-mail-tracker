import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareBodyText, stripEmbeddedImages } from '../src/domain/body-text.js';

test('data URI 图片被替换为占位符，正文语义保留', () => {
  const input = `【面试职位】：示例技术培训生（2027届）\n请扫描二维码：data:image/jpeg;base64,${REAL_B64_CHUNK.repeat(40)}\n携带材料：身份证复印件`;
  const out = stripEmbeddedImages(input);
  assert.match(out, /示例技术培训生/, '岗位名必须保留');
  assert.match(out, /身份证复印件/, '图片之后的正文必须保留');
  assert.ok(!out.includes('4AAQSkZJRgABAQEAYABgAAD'), 'base64 必须被剥掉');
  assert.match(out, /\[图片\]/);
});

test('裸 base64 块（无 data: 前缀）同样被剥掉', () => {
  const b64 = REAL_B64_CHUNK.repeat(40);
  const input = `您的验证码是 123456\n${b64}\n感谢使用`;
  const out = stripEmbeddedImages(input);
  assert.ok(!out.includes(b64), '裸 base64 也必须剥掉');
  assert.match(out, /验证码/);
  assert.match(out, /感谢使用/);
});

test('相邻多个图片折叠成一个占位符，不刷屏', () => {
  const input = `岗位：产品经理\n[图片]\n[图片]\n[图片]\n结尾`;
  const out = stripEmbeddedImages(input);
  const count = (out.match(/\[图片\]/g) || []).length;
  assert.equal(count, 1, `连续图片应折叠为 1 个占位符，实际 ${count}`);
  assert.match(out, /产品经理/);
});

test('普通长文本不被误伤（长 URL / 长英文词不算图片）', () => {
  const longUrl = `https://example.com/apply?token=${'a'.repeat(300)}&session=${'b'.repeat(300)}`;
  const input = `请点击 ${longUrl} 开始测评`;
  const out = stripEmbeddedImages(input);
  assert.equal(out, input, '长 URL 必须原样保留');
});

// 构造一段真实的 JPEG base64（真实编码几乎不产生 '+'，但 '/' 很多，
// 不同字符数达 40+）——这是判据的来源，不能用 'aaaa' 这种假样本。
const REAL_B64_CHUNK =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAA' +
  'AAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

test('真实 base64（无 data: 前缀）也被剥掉', () => {
  const b64 = REAL_B64_CHUNK.repeat(40); // ~9600 字符，真实图片量级
  assert.ok(b64.length > 800, '样本需超过阈值');
  const input = `岗位：产品经理\n${b64}\n联系方式`;
  const out = stripEmbeddedImages(input);
  assert.ok(!out.includes(b64), '真实 base64 必须被剥掉');
  assert.match(out, /产品经理/);
  assert.match(out, /联系方式/);
});

test('十六进制 token（md5/hash）不被误判为图片', () => {
  const hex = '0123456789abcdef'.repeat(60); // 960 字符，超过 800 阈值
  const input = `校验码 ${hex} 请核验`;
  const out = stripEmbeddedImages(input);
  assert.match(out, /校验码/, 'hex token 应保留');
  assert.ok(out.includes(hex.slice(0, 40)), 'hex token 内容应保留');
});

test('单字符长重复串不被误判为图片', () => {
  const input = `填充 ${'x'.repeat(500)} 结束`;
  const out = stripEmbeddedImages(input);
  assert.match(out, /填充/);
  assert.match(out, /结束/);
});

test('空值与非字符串输入安全', () => {
  assert.equal(stripEmbeddedImages(null), '');
  assert.equal(stripEmbeddedImages(undefined), '');
  assert.equal(stripEmbeddedImages(''), '');
  assert.equal(stripEmbeddedImages(12345), '12345');
});

test('先剥图片再截断：截断额度不被垃圾占用', () => {
  // 真实场景：18018 字正文，15615 字是 base64，岗位在第一行
  const jobLine = '【面试职位】：示例技术培训生（2027届）';
  const b64 = REAL_B64_CHUNK.repeat(150);
  const input = `${jobLine}\n[data:image/png;base64,${b64}]`;
  assert.ok(input.length > 1000, '构造的输入确实超长');

  // 截断上限 800：若不先清洗，额度全被 base64 占满，岗位行仍会保留但正文全丢；
  // 清洗后正文大幅缩短，完整内容都在。
  const out = prepareBodyText(input, 800);
  assert.ok(!out.includes('4AAQSkZJRgABAQEAYABgAAD'), '截断结果不得含 base64 残留');
  assert.match(out, /示例技术培训生/);
});

test('截断在超长纯净正文上仍然生效', () => {
  // 逐行拼接，避免构造出连续重复字符（那会被清洗规则识别为非 base64 填充）
  const input = Array.from({ length: 200 }, (_, i) => `第${i}行内容`).join('\n');
  const out = prepareBodyText(input, 100);
  assert.equal(out.length, 100);
});

test('prepareBodyText 对未超限输入是恒等变换', () => {
  const input = '普通正文，没有图片，也没有 base64。';
  assert.equal(prepareBodyText(input, 24_000), input);
});
