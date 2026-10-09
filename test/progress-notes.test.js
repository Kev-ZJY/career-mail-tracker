import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressNotes } from '../src/domain/progress-notes.js';

test('submitted, offer, and ended progress never display notes', () => {
  for (const status of ['已投递', 'Offer', '已结束']) {
    assert.equal(buildProgressNotes({
      status,
      notes: '岗位未识别；感谢投递；https://irrelevant.example.test',
      actionLink: 'https://assessment.example.test/start',
      eventEnd: '2026-09-14T02:42:23.000Z',
    }), '');
  }
});

test('assessment notes contain only the assessment link and Beijing deadline', () => {
  assert.equal(buildProgressNotes({
    status: '测评中',
    notes: '邮件未注明岗位名称，已留空待人工确认。',
    actionLink: 'https://assessment.example.test/start?token=abc',
    eventEnd: '2026-09-14T02:42:23.000Z',
  }), '测评链接：https://assessment.example.test/start?token=abc；测评截止时间：2026-09-14 10:42');
});

test('assessment notes may recover a manually entered URL but discard all prose', () => {
  assert.equal(buildProgressNotes({
    status: '测评中',
    notes: '请尽快处理；测评链接：https://assessment.example.test/manual；莫名其妙的邮件原文',
  }), '测评链接：https://assessment.example.test/manual');
});

test('interview notes contain only the interview URL', () => {
  assert.equal(buildProgressNotes({
    status: '面试',
    notes: '岗位未识别；面试链接：https://meeting.example.test/room；下载链接：https://download.example.test/app',
    actionLink: 'https://meeting.example.test/room',
    eventEnd: '2026-09-14T02:42:23.000Z',
  }), '面试链接：https://meeting.example.test/room');
});

test('assessment and interview notes are empty when no allowed field exists', () => {
  assert.equal(buildProgressNotes({ status: '测评中', notes: '邮件原文片段' }), '');
  assert.equal(buildProgressNotes({ status: '面试', notes: '岗位未识别' }), '');
});
