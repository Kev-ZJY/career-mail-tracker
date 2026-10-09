import test from 'node:test';
import assert from 'node:assert/strict';
import { redactErrorMessage } from '../src/domain/error-message.js';

test('connection-level wording is preserved verbatim', () => {
  // 这些措辞本身就是诊断主力，且不含身份信息——脱敏反而会把线索抹掉。
  for (const message of [
    'fetch failed',
    'socket hang up',
    'read ECONNRESET',
    'getaddrinfo ENOTFOUND api.internal.corp',
    'The operation was aborted',
  ]) {
    assert.equal(redactErrorMessage(message), message);
  }
});

test('credentials never survive redaction', () => {
  assert.match(redactErrorMessage('Authorization: Bearer sk-abcdef1234567890 rejected'), /\[credential\]/);
  assert.doesNotMatch(redactErrorMessage('Bearer sk-abcdef1234567890'), /abcdef1234567890/);
  assert.doesNotMatch(redactErrorMessage('key sk-abcdef1234567890 invalid'), /abcdef1234567890/);
});

test('network error wording cannot bypass credential and URL redaction', () => {
  const result = redactErrorMessage('fetch failed: Bearer sk-abcdef1234567890 https://example.test/v1?key=private-secret');
  assert.match(result, /fetch failed/);
  assert.doesNotMatch(result, /abcdef1234567890|private-secret/);
});

test('url paths and query strings are dropped but the origin stays', () => {
  const out = redactErrorMessage('request to https://api.example.com/v1/chat?key=supersecret failed');
  assert.match(out, /api\.example\.com/, '保留 origin，够判断是哪个上游');
  assert.doesNotMatch(out, /supersecret/, 'query 里的 key 不能漏');
  assert.doesNotMatch(out, /\/v1\/chat/, 'path 不需要');
});

test('email addresses are masked', () => {
  const out = redactErrorMessage('login failed for candidate@privacy.example.test');
  assert.doesNotMatch(out, /candidate|privacy\.example\.test/);
  assert.match(out, /\*\*\*/);
});

test('absolute paths keep only the last two segments', () => {
  const out = redactErrorMessage('cannot read /Users/example_user/Documents/secrets/api-key.json');
  assert.doesNotMatch(out, /example_user/, '用户名不能出现在对外的失败记录里');
  assert.match(out, /api-key\.json/);
});

test('long hex ids are masked', () => {
  assert.doesNotMatch(redactErrorMessage('request 0123456789abcdef0123 failed'), /0123456789abcdef/);
});

test('a long message is truncated', () => {
  const out = redactErrorMessage('x'.repeat(500));
  assert.equal(out.length, 200);
});

test('an empty or non-string message becomes an empty string', () => {
  assert.equal(redactErrorMessage(''), '');
  assert.equal(redactErrorMessage(undefined), '');
  assert.equal(redactErrorMessage(null), '');
  assert.equal(redactErrorMessage(123), '');
});
