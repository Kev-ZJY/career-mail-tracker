import test from 'node:test';
import assert from 'node:assert/strict';
import { getMailboxProvider } from '../src/mail/provider-registry.js';

test('both providers default to implicit TLS on port 993', () => {
  // 授权码是长期有效的明文口令，任何时候都不能默认走明文端口
  for (const id of ['qq', 'netease']) {
    const profile = getMailboxProvider(id, {});
    assert.equal(profile.port, 993);
    assert.equal(profile.secure, true);
  }
});

test('unknown provider id is rejected', () => {
  assert.throws(() => getMailboxProvider('gmail', {}), /provider must be qq or netease/);
});

test('host override accepts whitelisted domains and IPs but rejects arbitrary hosts', () => {
  const allowed = getMailboxProvider('netease', { IMAP_163_HOST: 'pop163.mail.ntes53.netease.com' });
  assert.equal(allowed.host, 'pop163.mail.ntes53.netease.com');

  const byIp = getMailboxProvider('netease', { IMAP_163_HOST: '203.0.113.7' });
  assert.equal(byIp.host, '203.0.113.7');

  // 形似白名单但归属他人域名的值必须被忽略，防止环境变量把连接指向任意主机
  const hijacked = getMailboxProvider('netease', { IMAP_163_HOST: 'imap.163.com.evil.example' });
  assert.equal(hijacked.host, 'imap.163.com');

  const unrelated = getMailboxProvider('netease', { IMAP_163_HOST: 'mail.example.com' });
  assert.equal(unrelated.host, 'imap.163.com');
});

test('overridden host keeps the original domain as SNI so certificate checks still apply', () => {
  const profile = getMailboxProvider('netease', { IMAP_163_HOST: '203.0.113.7' });
  assert.equal(profile.tlsServername, 'imap.163.com');
});

test('port and TLS can be downgraded only through explicit environment variables', () => {
  const downgraded = getMailboxProvider('netease', { IMAP_163_PORT: '143', IMAP_163_SECURE: '0' });
  assert.equal(downgraded.port, 143);
  assert.equal(downgraded.secure, false);

  // 环境变量写错时回落到安全默认，而不是变成 undefined
  const garbage = getMailboxProvider('netease', { IMAP_163_PORT: 'not-a-port' });
  assert.equal(garbage.port, 993);
  assert.equal(garbage.secure, true);
});

test('qq provider reads its own environment variables', () => {
  const profile = getMailboxProvider('qq', { IMAP_QQ_HOST: 'imap.qq.com', IMAP_QQ_PORT: '993' });
  assert.equal(profile.host, 'imap.qq.com');
  assert.equal(profile.port, 993);
  assert.equal(profile.secure, true);
});
