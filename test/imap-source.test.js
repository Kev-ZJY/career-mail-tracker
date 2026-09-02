import test from 'node:test';
import assert from 'node:assert/strict';
import { getMailboxProvider } from '../src/mail/provider-registry.js';
import { createImapSource } from '../src/services/imap-source.js';

test('imap source searches INBOX by inclusive dates and drops attachment data from normalized messages', async () => {
  let searchQuery;
  let released = false;
  const source = createImapSource({
    providerRegistry: getMailboxProvider,
    clientFactory: (options) => ({
      options,
      mailbox: { uidValidity: 77 },
      connect: async () => {},
      getMailboxLock: async (folder) => {
        assert.equal(folder, 'INBOX');
        return { release: () => { released = true; } };
      },
      search: async (query, options) => {
        searchQuery = { query, options };
        return [9];
      },
      fetchAll: async () => [{
        uid: 9,
        envelope: { messageId: '<envelope@test>', date: new Date('2026-08-12T09:00:00Z') },
        source: Buffer.from('raw message'),
      }],
      logout: async () => {},
    }),
    parser: async () => ({
      messageId: '<m-1@test>',
      date: new Date('2026-08-12T09:00:00Z'),
      from: [{ name: '招聘团队', address: 'jobs@example.test' }],
      subject: '面试邀请',
      text: '公司：示例科技\n职位：后端开发工程师',
      html: '<p>面试邀请</p><a href="https://meeting.example.test/interview/abc">进入面试</a>',
      attachments: [{ filename: 'offer.pdf', content: Buffer.from('attachment body') }],
    }),
  });

  const messages = await source.fetchMessages({
    provider: 'netease',
    email: 'a@163.com',
    authorizationCode: 'secret',
    from: '2026-08-01',
    to: '2026-08-31',
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].folder, 'INBOX');
  assert.equal(messages[0].uidValidity, '77');
  assert.equal(messages[0].uid, '9');
  assert.equal(messages[0].messageId, '<m-1@test>');
  assert.equal(messages[0].sender, '招聘团队 <jobs@example.test>');
  assert.match(messages[0].text, /https:\/\/meeting\.example\.test\/interview\/abc/);
  assert.equal(messages[0].text.includes('attachment body'), false);
  assert.equal('attachments' in messages[0], false);
  assert.equal(searchQuery.options.uid, true);
  // 时区安全垫：搜索窗口前后各扩 1 天（UTC 日界），精确过滤由 sync-service 兜底
  assert.equal(searchQuery.query.since.toISOString(), '2026-07-31T00:00:00.000Z');
  assert.equal(searchQuery.query.before.toISOString(), '2026-09-02T00:00:00.000Z');
  assert.equal(released, true);
});

test('imap source fetches all matched uids when no maxMessages is given', async () => {
  let fetchedUids;
  const source = createImapSource({
    providerRegistry: getMailboxProvider,
    clientFactory: () => ({
      mailbox: { uidValidity: 77 },
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [1, 2, 3, 4, 5],
      fetchAll: async (uids) => { fetchedUids = uids; return []; },
      logout: async () => {},
    }),
  });

  await source.fetchMessages({
    provider: 'qq',
    email: 'a@qq.com',
    authorizationCode: 'secret',
    from: '2026-08-01',
    to: '2026-08-31',
  });

  assert.deepEqual(fetchedUids, [1, 2, 3, 4, 5]);
});

test('imap source truncates to the newest N uids when maxMessages is given', async () => {
  let fetchedUids;
  const source = createImapSource({
    providerRegistry: getMailboxProvider,
    clientFactory: () => ({
      mailbox: { uidValidity: 77 },
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [1, 2, 3],
      fetchAll: async (uids) => { fetchedUids = uids; return []; },
      logout: async () => {},
    }),
  });

  await source.fetchMessages({
    provider: 'qq',
    email: 'a@qq.com',
    authorizationCode: 'secret',
    from: '2026-08-01',
    to: '2026-08-31',
    maxMessages: 2,
  });

  // 截断必须丢最旧的、保最新的，避免窗口超限时漏掉最新邮件
  assert.deepEqual(fetchedUids, [2, 3]);
});

test('imap source recovers job titles hidden in contenteditable=false spans from html', async () => {
  const source = createImapSource({
    providerRegistry: getMailboxProvider,
    clientFactory: () => ({
      mailbox: { uidValidity: 77 },
      connect: async () => {},
      getMailboxLock: async () => ({ release: async () => {} }),
      search: async () => [1],
      fetchAll: async () => [{
        uid: 1,
        envelope: { messageId: '<m@test>', date: new Date('2026-01-19T02:56:49Z') },
        source: Buffer.from('raw'),
      }],
      logout: async () => {},
    }),
    parser: async () => ({
      messageId: '<m@test>',
      date: new Date('2026-01-19T02:56:49Z'),
      from: [{ name: '小红书', address: 'hr@xiaohongshu.com' }],
      subject: '【小红书】面试邀请',
      // 模拟 mailparser 的行为：html-to-text 把 contenteditable=false 的职位名丢掉，只留链接
      text: '链接：https://meeting.tencent.com/dm/A2jlbviCYeOU',
      html: '<p>现邀请您参加<span contenteditable="false"><span id="js-position-name">视频用户产品实习生</span></span></p><a href="https://meeting.tencent.com/dm/A2jlbviCYeOU">进入会议</a>',
      attachments: [],
    }),
  });

  const messages = await source.fetchMessages({
    provider: 'netease', email: 'a@163.com', authorizationCode: 'secret',
    from: '2026-01-01', to: '2026-01-31',
  });

  assert.equal(messages.length, 1);
  // 职位名必须从 html 兜底恢复进 text，模型才能抽到
  assert.match(messages[0].text, /视频用户产品实习生/);
  // 不重复追加
  assert.equal((messages[0].text.match(/视频用户产品实习生/g) || []).length, 1);
});
