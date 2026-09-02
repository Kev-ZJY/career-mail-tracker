import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompany, extractPositionFromSubject, extractPositionFromText } from '../src/domain/normalize.js';

test('normalizeCompany merges known aliases and leaves others untouched', () => {
  assert.equal(normalizeCompany('快手科技'), '快手');
  assert.equal(normalizeCompany('快手'), '快手');
  assert.equal(normalizeCompany('深圳虾皮信息科技有限公司'), 'Shopee');
  assert.equal(normalizeCompany('腾讯'), '腾讯');
  assert.equal(normalizeCompany(''), '');
});

test('extractPositionFromSubject pulls the position from xiaohongshu-style subjects', () => {
  assert.equal(
    extractPositionFromSubject('【小红书招聘】简历投递成功 - 张三 - 视频用户产品实习生'),
    '视频用户产品实习生',
  );
  assert.equal(
    extractPositionFromSubject('【小红书招聘】简历投递成功 - 张三 - 交通出行行业平台专家实习生'),
    '交通出行行业平台专家实习生',
  );
  // 职位名本身含连字符时也要完整保留
  assert.equal(
    extractPositionFromSubject('【小红书招聘】简历投递成功 - 张三 - Product Engineer-产品工程师（AI应用产品经理方向）-质效研发'),
    'Product Engineer-产品工程师（AI应用产品经理方向）-质效研发',
  );
});

test('extractPositionFromSubject handles the thank-you-application style', () => {
  assert.equal(
    extractPositionFromSubject('张三，感谢你投递九号公司公司的2027届暑期实习-产品运营助理职位'),
    '2027届暑期实习-产品运营助理',
  );
});

test('extractPositionFromSubject returns empty for subjects without a clear position', () => {
  assert.equal(extractPositionFromSubject('【小红书】面试邀请'), '');
  assert.equal(extractPositionFromSubject('P&G - Invitation to Online Assessment'), '');
  assert.equal(extractPositionFromSubject(''), '');
});

test('extractPositionFromText covers interview-slot and english anchors', () => {
  assert.equal(extractPositionFromText('面试岗位：【CN IT-DIGITAL&RETAIL】 面试时间：北京时间 2026'), 'CN IT-DIGITAL&RETAIL');
  assert.equal(
    extractPositionFromText('Thank you for applying for the position of (Chinese Mainland) Internship Recruiting - Research & Development Summer Intern. We truly appreciate'),
    '(Chinese Mainland) Internship Recruiting - Research & Development Summer Intern',
  );
  assert.equal(extractPositionFromText('没有岗位的普通文本'), '');
});

test('cleanPosition strips the trailing 岗位 token and broken 【实习 prefix', () => {
  // 通过 subject 兜底路径验证（cleanPosition 内部逻辑）
  assert.equal(
    extractPositionFromSubject('【小红书招聘】简历投递成功 - 张三 - ASP - AI Star Program 产品经理培训生岗位'),
    'ASP - AI Star Program 产品经理培训生',
  );
});
