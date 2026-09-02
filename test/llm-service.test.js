import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClassifier, validateOutput, EXTRACTION_PROMPT } from '../src/services/llm-service.js';

const validModelOutput = {
  isJobRelated: true,
  company: '示例科技',
  position: '后端开发工程师',
  status: '面试',
  confidence: 0.93,
  evidence: '邮件明确邀请参加技术面试。',
  nextAction: '确认面试时间并准备面试。',
  needsReview: false,
  eventStart: '2026-08-21T10:30:00.000Z',
  eventEnd: '2026-08-21T11:30:00.000Z',
  notes: '面试链接：https://interview.example.test/1',
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('llm classifier sends a bounded prompt to an OpenAI-compatible provider and validates JSON output', async () => {
  let request;
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  const result = await classifier.classify({ subject: '面试邀请', text: '公司：示例科技\n面试时间：2026-08-21 18:30' });

  assert.equal(result.status, '面试');
  assert.equal(result.eventStart, validModelOutput.eventStart);
  assert.equal(request.url, 'https://model.test/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer secret-key');
  assert.equal(request.options.body.includes('secret-key'), false);
});

test('llm classifier throws when the provider returns an invalid status (no rule fallback)', async () => {
  const classifier = createLlmClassifier({
    provider: { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' },
    credentialStore: { get: () => null },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '{"status":"unknown"}' } }] }),
  });

  await assert.rejects(
    () => classifier.classify({ subject: '招聘', text: '内容' }),
    /model status is invalid/,
  );
});

test('llm classifier accepts 已结束 as a valid non-offer recruitment status', async () => {
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({
      ...validModelOutput,
      status: '已结束',
      evidence: '招聘流程已结束。',
    }) } }] }),
  });

  assert.equal((await classifier.classify({ subject: '流程结束', text: '招聘流程已结束。' })).status, '已结束');
});

test('llm prompt explicitly excludes recruitment announcements and job recommendations', async () => {
  let requestBody = '';
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '招聘活动预告', text: '岗位推荐与宣讲会通知', receivedAt: '2026-08-21T11:40:00.000Z' });
  assert.match(requestBody, /招聘活动/);
  assert.match(requestBody, /岗位推荐/);
  assert.match(requestBody, /不属于个人招聘进度/);
  assert.match(requestBody, /已结束/);
  assert.match(requestBody, /北京时间/);
});

test('llm classifier throws on legacy rejection output instead of guessing (no rule fallback)', async () => {
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ ...validModelOutput, status: '拒绝' }) } }] }),
  });

  await assert.rejects(
    () => classifier.classify({ subject: '拒信', text: '很遗憾未通过。' }),
    /model status is invalid/,
  );
});

const openThreadsFixture = [
  { id: 3, company: '示例科技', position: '后端开发工程师', status: '面试' },
  { id: 7, company: '示例科技', position: '前端开发工程师', status: '测评中' },
];

test('extraction prompt defines the threadRef and appliesTo contract', () => {
  assert.match(EXTRACTION_PROMPT, /threadRef/);
  assert.match(EXTRACTION_PROMPT, /appliesTo/);
  assert.match(EXTRACTION_PROMPT, /"new"/);
});

test('classify injects the open thread list into the user message', async () => {
  let requestBody = '';
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '面试邀请', text: '请参加面试。', openThreads: openThreadsFixture });
  assert.match(requestBody, /#3 示例科技 后端开发工程师（状态：面试）/);
  assert.match(requestBody, /#7 示例科技 前端开发工程师（状态：测评中）/);
  assert.match(requestBody, /threadRef/);
});

test('validateOutput keeps a threadRef that is "new" or exists in openThreads, and strips the rest', () => {
  const input = { subject: '面试邀请', text: '请参加面试。', openThreads: openThreadsFixture };

  assert.equal(validateOutput({ ...validModelOutput, threadRef: 3 }, input).threadRef, 3);
  assert.equal(validateOutput({ ...validModelOutput, threadRef: 'new' }, input).threadRef, 'new');
  assert.equal('threadRef' in validateOutput({ ...validModelOutput, threadRef: 99 }, input), false);
  assert.equal('threadRef' in validateOutput({ ...validModelOutput, threadRef: 'abc' }, input), false);
  assert.equal('threadRef' in validateOutput({ ...validModelOutput, threadRef: 7.5 }, input), false);
  assert.equal('threadRef' in validateOutput(validModelOutput, input), false);
});

test('validateOutput filters appliesTo down to known thread ids', () => {
  const input = { subject: '测评通知', text: '请完成测评。', openThreads: openThreadsFixture };

  assert.deepEqual(
    validateOutput({ ...validModelOutput, appliesTo: [3, 7, 99, 'x'] }, input).appliesTo,
    [3, 7],
  );
  assert.equal('appliesTo' in validateOutput({ ...validModelOutput, appliesTo: [99] }, input), false);
  assert.equal('appliesTo' in validateOutput(validModelOutput, input), false);
});

test('validateOutput strips a hallucinated position and flags the row for review', () => {
  const result = validateOutput(
    { ...validModelOutput, position: '火星殖民地专员' },
    { subject: '面试邀请', text: '公司：示例科技\n面试时间：2026-08-21 18:30', openThreads: openThreadsFixture },
  );

  assert.equal(result.position, '');
  assert.equal(result.needsReview, true);
});

test('validateOutput keeps a position that actually appears in the email', () => {
  const result = validateOutput(
    { ...validModelOutput, position: '后端开发' },
    { subject: '面试邀请', text: '公司：示例科技\n职位：后端开发工程师\n面试时间：2026-08-21 18:30', openThreads: openThreadsFixture },
  );

  assert.equal(result.position, '后端开发');
  assert.equal(result.needsReview, false);
});

test('cleanBaseUrl accepts a full chat-completions endpoint as baseUrl', async () => {
  let requestedUrl = '';
  const classifier = createLlmClassifier({
    provider: { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', model: 'stealth/ox-alpha', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '面试邀请', text: '请参加面试。' });
  assert.equal(requestedUrl, 'https://openrouter.ai/api/v1/chat/completions');
});

test('DeepSeek extraction requests explicitly disable thinking mode', async () => {
  let requestBody = '';
  const classifier = createLlmClassifier({
    provider: { id: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '面试邀请', text: '请参加面试。' });
  assert.deepEqual(JSON.parse(requestBody).thinking, { type: 'disabled' });
});

test('llm classifier drops hallucinated event times when the email has no explicit date or clock time', async () => {
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({
      ...validModelOutput,
      status: '面试',
      eventStart: '2026-07-22T20:00:00.000Z',
      eventEnd: '2026-07-22T21:00:00.000Z',
    }) } }] }),
  });

  const result = await classifier.classify({
    subject: '腾讯校园招聘——校招面试邀请反馈',
    text: '请填写面试反馈问卷。面试时间：未提供。北京时间：无。',
    receivedAt: '2026-07-22T12:45:03.000Z',
  });

  assert.equal(result.eventStart, undefined);
  assert.equal(result.eventEnd, undefined);
  assert.equal(result.needsReview, true);
  assert.match(result.notes, /未提供明确时间|忽略/);
});

test('validateOutput blanks process-word positions even when the subject contains them verbatim', () => {
  const input = {
    subject: '【小红书】面试邀请',
    text: '链接：https://meeting.example.test/1',
    openThreads: openThreadsFixture,
  };
  for (const pos of ['面试邀请', '现场访客码', '测评邀请', '未提及', '应聘反馈', '简历投递成功', '面试反馈', '访客码', '投递成功']) {
    const result = validateOutput({ ...validModelOutput, position: pos }, input);
    assert.equal(result.position, '', `position "${pos}" must be blanked`);
    assert.equal(result.needsReview, true, `position "${pos}" must flag review`);
  }
});

test('validateOutput blanks process-word variants like 腾讯现场访客码', () => {
  const result = validateOutput(
    { ...validModelOutput, position: '腾讯现场访客码' },
    {
      subject: '腾讯招聘——现场访客码通知',
      text: '感谢您投递腾讯，现邀请您参加现场面试',
      openThreads: openThreadsFixture,
    },
  );

  assert.equal(result.position, '');
  assert.equal(result.needsReview, true);
});

test('validateOutput keeps a position extracted from the subject delimiter pattern', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '商业化产品运营实习生' },
    {
      subject: '【小红书招聘】简历投递成功 - 张三 - 商业化产品运营实习生',
      text: '',
      openThreads: openThreadsFixture,
    },
  );

  assert.equal(result.position, '商业化产品运营实习生');
  assert.equal(result.needsReview, false);
});

test('validateOutput keeps 届次 prefixes as part of the position when they are the full position name', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const subject = '张三，感谢你投递九号公司公司的2027届暑期实习-产品运营助理职位';
  const result = validateOutput(
    { ...noTimeOutput, position: '2027届暑期实习-产品运营助理' },
    {
      subject,
      text: '链接：https://sctrack.sendcloud.net/track/unsubscribe2.do',
      openThreads: openThreadsFixture,
    },
  );

  assert.equal(result.position, '2027届暑期实习-产品运营助理');
  assert.equal(result.needsReview, false);
});

test('validateOutput strips batch-only positions like 2027届暑期实习 without a real role name', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const input = {
    subject: '【九号公司】2027届暑期实习',
    text: '感谢你投递2027届暑期实习',
    openThreads: openThreadsFixture,
  };
  for (const pos of ['2027届暑期实习', '27届校招', '2026春招', '【转正实习】']) {
    const result = validateOutput({ ...noTimeOutput, position: pos }, input);
    assert.equal(result.position, '', `position "${pos}" must be blanked`);
    assert.equal(result.needsReview, true, `position "${pos}" must flag review`);
  }
});

test('validateOutput blanks project/batch names that contain no concrete role', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  for (const [pos, subject, text] of [
    ['2026欧莱雅（中国）暑期实习生', '【2026欧莱雅（中国）暑期实习生】测评通知', '欢迎你参加2026欧莱雅（中国）暑期实习生线上测评'],
    ['秋储实习生', '【滴滴招聘】简历成功投递通知', '感谢您关注滴滴秋储实习生招聘'],
    ['滴滴秋储实习生', '【滴滴招聘】简历成功投递通知', '感谢您关注滴滴秋储实习生招聘'],
  ]) {
    const result = validateOutput(
      { ...noTimeOutput, position: pos },
      { subject, text, openThreads: openThreadsFixture },
    );
    assert.equal(result.position, '', `position "${pos}" must be blanked`);
    assert.equal(result.needsReview, true, `position "${pos}" must flag review`);
  }
});

test('validateOutput strips leading timestamps glued to the position', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  for (const [raw, expected, corpus] of [
    ['2026-01-20 15:00:00视频用户产品实习生', '视频用户产品实习生', '感谢您参加2026-01-20 15:00:00视频用户产品实习生的面试'],
    ['3月12日 14:30产品运营', '产品运营', '面试时间：3月12日 14:30产品运营'],
  ]) {
    const result = validateOutput(
      { ...noTimeOutput, position: raw },
      { subject: '面试安排', text: corpus, openThreads: openThreadsFixture },
    );
    assert.equal(result.position, expected, `"${raw}" must strip the timestamp`);
    assert.equal(result.needsReview, false, `"${raw}" must not flag review`);
  }
});

test('validateOutput strips generic bracket words like 【实习】 but keeps qualified ones like 【转正实习】', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const generic = validateOutput(
    { ...noTimeOutput, position: '【实习】产品经理-AI方向' },
    {
      subject: '联想2026实习生招聘-面试邀约',
      text: '面试职位：【实习】产品经理-AI方向',
      openThreads: openThreadsFixture,
    },
  );
  assert.equal(generic.position, '产品经理-AI方向');
  assert.equal(generic.needsReview, false);

  const qualified = validateOutput(
    { ...noTimeOutput, position: '【转正实习】产品经理岗' },
    {
      subject: '【转正实习】产品经理岗面试邀约',
      text: '面试职位：【转正实习】产品经理岗',
      openThreads: openThreadsFixture,
    },
  );
  assert.equal(qualified.position, '【转正实习】产品经理岗');
  assert.equal(qualified.needsReview, false);
});

test('validateOutput strips batch prefixes like 2027实习生校园招聘- before the real role', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '2027实习生校园招聘-【留用实习】数据分析师-风控治理方向' },
    {
      subject: '快手2027实习生面试邀请',
      text: '快手诚邀你参加2027实习生校园招聘-【留用实习】数据分析师-风控治理方向的面试',
      openThreads: openThreadsFixture,
    },
  );
  assert.equal(result.position, '【留用实习】数据分析师-风控治理方向');
  assert.equal(result.needsReview, false);
});

test('validateOutput keeps an empty position as empty when the email has no position', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '' },
    { subject: '【小红书】面试邀请', text: '链接：https://meeting.example.test/1', openThreads: openThreadsFixture },
  );

  assert.equal(result.position, '');
  assert.equal(result.needsReview, false);
});

test('extraction prompt bans process words from position and requires empty string when absent', () => {
  assert.match(EXTRACTION_PROMPT, /面试邀请/);
  assert.match(EXTRACTION_PROMPT, /现场访客码/);
  assert.match(EXTRACTION_PROMPT, /未提及/);
  assert.match(EXTRACTION_PROMPT, /简历投递成功/);
  assert.match(EXTRACTION_PROMPT, /必须返回空字符串/);
  assert.match(EXTRACTION_PROMPT, /商业化产品运营实习生/);
});
