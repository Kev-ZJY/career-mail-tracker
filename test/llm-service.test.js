import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmClassifier,
  validateOutput,
  EXTRACTION_PROMPT,
} from '../src/services/llm-service.js';

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

test('a reasoning-only endpoint gets no reasoning:false and a large max_tokens budget', async () => {
  // 回归守卫：这两个字段曾经各错一次。
  // 1) 下发 reasoning:{enabled:false} → 上游 400 "Reasoning is mandatory for this endpoint"；
  // 2) max_tokens 沿用 700 → 思考吃光预算，返回 finish_reason=length 且 content 为空。
  let body;
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'stealth/space-bunny-alpha',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  const result = await classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' });

  assert.equal(result.status, '面试');
  assert.equal(body.reasoning, undefined, 'reasoning-only 端点不能收到 reasoning 字段');
  assert.equal(body.max_tokens, 4000);
});

test('an ordinary openrouter model still disables reasoning explicitly', async () => {
  let body;
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'nvidia/nemotron-3.5-lightning:free',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' });

  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.max_tokens, 700);
});

test('a truncated reasoning response is retried once with a larger budget', async () => {
  // 回归守卫：reasoning 模型的思考长度极不稳定（实测同一封示例物流邮件的
  // reasoning 字符数在 3182~21105 之间波动），4000 预算下生产实测 25 封有 2 封截断。
  // 首次按快路径预算请求并被截断 → 用更大预算重发一次并成功。
  const bodies = [];
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'stealth/space-bunny-alpha',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{ finish_reason: 'length', message: { content: '', reasoning: '...' } }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  const result = await classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' });

  assert.equal(result.status, '面试');
  assert.equal(bodies.length, 2, '截断后必须重试一次');
  assert.equal(bodies[0].max_tokens, 4000, '首次走快路径预算');
  assert.equal(bodies[1].max_tokens, 16000, '重试必须用更大的预算');
  assert.equal(bodies[1].reasoning, undefined, '重试仍然不能下发 reasoning:false');
});

test('a truncated response with partial content is still treated as truncation', async () => {
  // 回归守卫：思考吃光预算时，有时会挤出一小截不完整 JSON（实测 500 预算下拿到
  // 35 字符的半截内容，finish_reason=length 但 content 非空）。旧实现只在
  // content 为空时才判截断，这种半截结果会走「内容存在但 JSON 不合法」的可重试
  // 路径，把残缺 JSON 当正常结果落库。
  const bodies = [];
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'stealth/space-bunny-alpha',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{ finish_reason: 'length', message: { content: '{"isJobRelated":tr', reasoning: '...' } }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  const result = await classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' });

  assert.equal(result.status, '面试');
  assert.equal(bodies.length, 2, '半截 JSON 也必须被识别为截断并重试');
  assert.equal(bodies[0].max_tokens, 4000);
  assert.equal(bodies[1].max_tokens, 16000);
});

test('a successful reasoning response is not retried', async () => {
  let calls = 0;
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'stealth/space-bunny-alpha',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validModelOutput) } }] });
    },
  });

  await classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' });
  assert.equal(calls, 1, '正常路径不得产生额外请求');
});

test('a timeout is not escalated to a larger budget', async () => {
  // 反向守卫：升级只针对「输出被截断」。超时是上游卡死，换预算没有意义，
  // 若也升级会把单封空转从 1 次请求变成 2 次。
  let calls = 0;
  const classifier = createLlmClassifier({
    provider: {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'stealth/space-bunny-alpha',
      credentialRef: 'key-1',
    },
    credentialStore: { get: () => 'secret-key' },
    timeoutMs: 20,
    fetchImpl: async () => {
      calls += 1;
      const error = new Error('boom');
      error.name = 'TimeoutError';
      throw error;
    },
  });

  await assert.rejects(
    () => classifier.classify({ subject: '面试邀请', text: '面试时间：2026-08-21 18:30' }),
    (error) => error.code === 'MODEL_TIMEOUT',
  );
  assert.equal(calls, 1, '超时不得触发预算升级重试');
});

test('llm classifier throws when the provider returns an invalid status (no rule fallback)', async () => {
  let call = 0;
  const classifier = createLlmClassifier({
    provider: { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' },
    credentialStore: { get: () => null },
    fetchImpl: async () => {
      call += 1;
      return jsonResponse({ choices: [{ message: { content: '{"status":"unknown"}' } }] });
    },
  });

  await assert.rejects(
    () => classifier.classify({ subject: '招聘', text: '内容' }),
    /model status is invalid/,
  );
  assert.equal(call, 1);
});

test('llm classifier marks provider rate limits as non-retryable for the current sync', async () => {
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429),
  });

  await assert.rejects(
    () => classifier.classify({ subject: '投递确认', text: '已收到申请。' }),
    (error) => error?.code === 'MODEL_RATE_LIMITED' && error?.status === 429,
  );
});

test('model 404 retains a redacted provider diagnosis and a configuration error code', async () => {
  const classifier = createLlmClassifier({
    provider: { id: 'ollama', baseUrl: 'http://model.test/v1/chat/completions/', model: 'missing' },
    fetchImpl: async (url) => {
      assert.equal(url, 'http://model.test/v1/chat/completions');
      return jsonResponse({ error: { message: 'No endpoints found. fetch failed Bearer sk-secret1234567890 https://example.test/private?key=secret' } }, 404);
    },
  });
  await assert.rejects(classifier.checkConnection(), (error) => {
    assert.equal(error.code, 'MODEL_NOT_FOUND');
    assert.equal(error.status, 404);
    assert.match(error.message, /No endpoints found/);
    assert.doesNotMatch(error.message, /secret1234567890|key=secret/);
    return true;
  });
});

test('an HTTP 200 upstream error is not mistaken for truncation or retried with more tokens', async () => {
  let calls = 0;
  const classifier = createLlmClassifier({ provider: { id: 'ollama', baseUrl: 'http://model.test/v1', model: 'fixture' },
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { code: 503, message: 'Service temporarily overloaded' } }); },
  });
  await assert.rejects(classifier.classify({}), (error) => error.code === 'MODEL_REQUEST_FAILED' && error.status === 503);
  assert.equal(calls, 1);
});

test('a probe can recover from one transient upstream error without sending mail', async () => {
  let calls = 0;
  const classifier = createLlmClassifier({ provider: { id: 'ollama', baseUrl: 'http://model.test/v1', model: 'fixture' },
    fetchImpl: async (_url, options) => {
      assert.doesNotMatch(options.body, /邮件接收时间|openThreads/);
      calls += 1;
      return calls === 1 ? jsonResponse({ error: { code: 503, message: 'Service temporarily overloaded' } }) : jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  assert.deepEqual(await classifier.checkConnection(), { ok: true });
  assert.equal(calls, 2);
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
  // 验证排除非个人进度、false 状态归一与北京时间年份语义。
  assert.match(requestBody, /false：[\s\S]*?宣讲会[\s\S]*?岗位推荐/);
  assert.match(requestBody, /false 时 status 填「已结束」/);
  assert.match(requestBody, /receivedAt 的北京时间年份/);
  // requestBody 是 JSON 序列化后的字符串，正文里的 "" 已被转义为 \"\"，
  // 所以这里只匹配 notes 的语义骨架，不匹配引号形态。
  assert.match(requestBody, /已投递、Offer、已结束填/);
  assert.match(requestBody, /禁止写「岗位未识别」/);
  assert.match(requestBody, /邀请未来申请，不算/);
});

test('extraction prompt keeps the exclusion rules semantically intact', () => {
  // 逐条守护重写后的关键业务语义。这些断言的价值在于「语义不能因为
  // 提速或精简而丢失」，措辞可以变。
  const required = [
    ['招聘活动属非个人进度', /宣讲会、招聘会、招聘活动预告/],
    ['岗位推荐属非个人进度', /岗位推荐、职位订阅/],
    ['未来申请不算进度', /邀请未来申请/],
    ['已完成动作算进度', /已收到你的申请/],
    // 定向联系候选人与群发岗位推荐有不同的进度语义。
    ['公司主动联系算已发生', /公司主动联系算已发生/],
    ['群发岗位推荐仍不算', /没有指名用户简历的才算 false/],
    ['尾部宣传不覆盖真实进度', /抽奖/],
    ['拒绝归入已结束', /拒绝归入已结束/],
    ['测评优先于Offer', /仍填测评中/],
    ['冲突优先级顺序', /已结束 > 测评中 > Offer > 面试 > 已投递/],
    ['不把ATS当公司', /ATS 或招聘平台/],
    ['中文公司名优先', /有中文名就填中文名/],
    ['公司填不出填空串', /填 \"\"/],
    ['流程词不算岗位', /访客码/],
    ['群面不算岗位', /群面/],
    ['无领导小组不算岗位', /无领导小组/],
    ['批量试卷命名填空串', /批量试卷名/],
    ['个人定向考卷要抽岗位', /只服务于收件人一个人/],
    ['岗位保留业务方向', /括号、破折号、斜线里的业务方向要保留/],
    ['字段值读到结束', /读到字段结束为止/],
    ['不编造时间', /不要编造/],
    ['threadRef 固定 new', /固定填 \"new\"/],
    // 面试通知中的附带测评不能覆盖主流程。
    ['区分主流程与附带动作', /注意区分主流程和附带动作/],
    ['附带在线测评时主流程仍是面试', /主流程是面试/],
    // 部门、业务方向和城市用于区分申请，不能过度缩写。
    ['部门城市不是冗余要保留', /部门、业务方向、城市不是冗余/],
    ['省部门会认错岗位的反例', /不要压成「工程师」/],
    // 明确的项目名称应保留，不能只接受传统岗位名。
    ['保留规则的对偶：项目名也要填', /反过来，保留规则也不等于宽松/],
    ['项目名岗位的正例', /示例全球培训计划（Example Global Program）/],
    // 区分实际流程撤回、订阅页脚和假设性诚信条款。
    ['已安排动作被撤回归入已结束', /已经为用户安排好的动作被撤回/],
    ['取消订阅不算流程取消', /取消订阅/],
    ['诚信条款的取消资格不算', /一经发现将取消面试资格/],
  ];
  const missing = required.filter(([, re]) => !re.test(EXTRACTION_PROMPT)).map(([n]) => n);
  assert.deepEqual(missing, [], `prompt 丢失了这些业务语义: ${missing.join('、')}`);
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

test('extraction prompt keeps routing local and does not request historical thread IDs', () => {
  assert.match(EXTRACTION_PROMPT, /threadRef/);
  assert.match(EXTRACTION_PROMPT, /历史申请由系统在本地归并/);
});

test('extraction prompt prefers Chinese company names from the current mail', () => {
  assert.match(EXTRACTION_PROMPT, /有中文名就填中文名/);
  assert.match(EXTRACTION_PROMPT, /只有英文名才填英文名/);
});

test('the unified extraction prompt preserves role directions and excludes test-paper titles', () => {
  assert.match(EXTRACTION_PROMPT, /职位\/岗位名称/);
  assert.match(EXTRACTION_PROMPT, /括号、破折号、斜线里的业务方向要保留/);
  assert.match(EXTRACTION_PROMPT, /收到您对 <岗位> 的申请/);
  // 批量试卷命名 vs 个人定向考卷的边界必须保留——这是 position 最容易错的地方
  assert.match(EXTRACTION_PROMPT, /批量试卷名/);
  assert.match(EXTRACTION_PROMPT, /只服务于收件人一个人/);
  // 岗位判定必须收敛到单一决策标准：旧 prompt 同时写「不得返回空字符串」
  // 和「才返回空字符串」，模型在无岗位邮件上会反复权衡、思考膨胀。
  assert.match(EXTRACTION_PROMPT, /直接连到「用户要应聘它」/);
  assert.ok(
    !/position 不得返回空字符串/.test(EXTRACTION_PROMPT),
    '不能再出现「不得返回空字符串」这类绝对表述，它和「才返回空字符串」自相矛盾',
  );
});

test('classifier completes company, position, status, and routing in one model request', async () => {
  let call = 0;
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => {
      call += 1;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        ...validModelOutput,
        position: '产品经理（音乐方向）',
      }) } }] });
    },
  });

  const result = await classifier.classify({
    subject: '简历投递成功',
    text: '职位名称：产品经理（音乐方向）',
  });
  assert.equal(call, 1);
  assert.equal(result.position, '产品经理（音乐方向）');
});

test('classifier does not multiply provider calls when the source has no position', async () => {
  let call = 0;
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => {
      call += 1;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        ...validModelOutput,
        position: '',
      }) } }] });
    },
  });

  const result = await classifier.classify({
    subject: '投递成功',
    text: '我们已收到您的申请。',
  });
  assert.equal(call, 1);
  assert.equal(result.position, '');
});

test('historical sibling brands cannot contaminate single-request mail extraction', async () => {
  let calls = 0;
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      const input = request.messages.map((message) => message.content).join('\n');
      const contaminated = input.includes('青岚音乐');
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        ...validModelOutput,
        company: contaminated ? '青岚音乐' : '青岚',
        position: contaminated ? '' : 'AI产品经理培训生',
        status: '测评中',
        threadRef: contaminated ? 10 : 'new',
      }) } }] });
    },
  });

  const result = await classifier.classify({
    sender: '青岚招聘 <campus@qinglan.example>',
    subject: '【青岚招聘】AI 实战测评通知',
    text: '感谢你投递 AI产品经理培训生岗位，请完成测评。',
    openThreads: [{ id: 10, company: '青岚音乐', position: '', status: '已投递' }],
  });

  assert.equal(calls, 1);
  assert.equal(result.company, '青岚');
  assert.equal(result.position, 'AI产品经理培训生');
  assert.equal(result.threadRef, 'new');
});

test('a model cannot route to a guessed historical thread id it never received', async () => {
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({
      ...validModelOutput,
      company: '青岚',
      position: 'AI产品经理培训生',
      threadRef: 10,
      appliesTo: [10],
    }) } }] }),
  });

  const result = await classifier.classify({
    sender: '青岚招聘 <campus@qinglan.example>',
    subject: '【青岚招聘】AI 实战测评通知',
    text: '感谢你投递 AI产品经理培训生岗位，请完成测评。',
    openThreads: [{ id: 10, company: '青岚音乐', position: '', status: '已投递' }],
  });

  assert.equal(result.threadRef, 'new');
  assert.equal('appliesTo' in result, false);
});

test('classify sends current mail but not historical applications to the model', async () => {
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
  const mailPrompt = JSON.parse(requestBody).messages[1].content;
  assert.match(mailPrompt, /主题：面试邀请/);
  assert.match(mailPrompt, /正文：请参加面试/);
  assert.doesNotMatch(mailPrompt, /#3|#7|后端开发工程师|前端开发工程师/);
});

test('company name reuse stays local after the unified model request', async () => {
  const requestBodies = [];
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ ...validModelOutput, company: '示例科技有限公司', threadRef: 'new' }) } }] });
    },
  });

  const result = await classifier.classify({
    subject: '面试邀请',
    text: '请参加面试。',
    openThreads: [
      ...openThreadsFixture,
      { id: 9, company: '另一家公司', position: '数据分析师', status: '已投递' },
    ],
  });

  assert.equal(requestBodies.length, 1);
  assert.equal(result.company, '示例科技');
  assert.doesNotMatch(requestBodies[0].messages[1].content, /另一家公司/);
});

test('company canonicalization does not replace an unrelated extracted company', async () => {
  const requestBodies = [];
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        ...validModelOutput,
        company: '新锐科技',
        position: '数据分析师',
        threadRef: 'new',
      }) } }] });
    },
  });

  const result = await classifier.classify({
    subject: '新锐科技投递成功',
    text: '已收到数据分析师申请。',
    openThreads: [{ id: 1, company: '远山智能', position: '前端工程师', status: '已投递' }],
  });

  assert.equal(requestBodies.length, 1);
  assert.equal(result.company, '新锐科技');
  assert.equal(requestBodies.some((body) => body.messages[0].content.includes('公司名称归一器')), false);
});

test('an organization-specific sender identity reuses an existing company across naming variants', async () => {
  const requestBodies = [];
  const classifier = createLlmClassifier({
    provider: { baseUrl: 'https://model.test/v1', model: 'test-model', credentialRef: 'key-1' },
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        ...validModelOutput,
        company: 'Example Technology',
        threadRef: 3,
      }) } }] });
    },
  });

  const result = await classifier.classify({
    subject: '面试邀请',
    text: '请参加面试。',
    sender: '示例科技招聘 <example-jobs@mail.vendor.test>',
    openThreads: [
      { id: 3, company: '示例科技', position: '后端开发工程师', status: '已投递', latestSender: '示例科技招聘 <example-jobs@mail.vendor.test>' },
      { id: 9, company: '远山智能', position: '数据分析师', status: '已投递', latestSender: 'far-jobs@mail.vendor.test' },
    ],
  });

  assert.equal(requestBodies.length, 1);
  assert.equal(result.company, '示例科技');
  assert.doesNotMatch(requestBodies[0].messages[1].content, /远山智能/);
});

test('validateOutput keeps a correct core position when the email includes extra cohort and location text', () => {
  const { eventStart, eventEnd, ...withoutEventTime } = validModelOutput;
  const result = validateOutput(
    { ...withoutEventTime, position: 'AI产品经理' },
    {
      subject: 'AI 产品经理（2027届校园招聘）- 示例城市',
      text: '我们已经收到您的申请。',
      openThreads: [],
    },
  );

  assert.equal(result.position, 'AI产品经理');
  assert.equal(result.needsReview, false);
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

test('validateOutput preserves an explicit all-applied-positions scope without historical ids', () => {
  const result = validateOutput({
    ...validModelOutput,
    status: '测评中',
    threadRef: 'new',
    appliesToAll: true,
  }, { subject: '在线测评', text: '本次测评适用于您投递的全部岗位。' });
  assert.equal(result.appliesToAll, true);
});

test('validateOutput does not pretend to semantically judge a model position with substring rules', () => {
  const { eventStart, eventEnd, ...withoutEventTime } = validModelOutput;
  const result = validateOutput(
    { ...withoutEventTime, position: '跨语言产品负责人' },
    { subject: 'Interview invitation', text: 'The role is described in another language.', openThreads: [] },
  );

  assert.equal(result.position, '跨语言产品负责人');
  assert.equal(result.needsReview, false);
});

test('validateOutput keeps a position that actually appears in the email', () => {
  const result = validateOutput(
    { ...validModelOutput, position: '后端开发' },
    { subject: '面试邀请', text: '公司：示例科技\n职位：后端开发工程师\n面试时间：2026-08-21 18:30', openThreads: openThreadsFixture },
  );

  assert.equal(result.position, '后端开发');
  assert.equal(result.needsReview, false);
});

test('validateOutput preserves a long actionable assessment URL in notes', () => {
  const url = `https://assessment.example.test/start?token=${'x'.repeat(260)}`;
  const { eventStart, eventEnd, ...withoutEventTime } = validModelOutput;
  const result = validateOutput(
    { ...withoutEventTime, status: '测评中', notes: `测评链接：${url}` },
    {
      subject: '后端开发工程师在线测评',
      text: `职位：后端开发工程师\n测评链接：${url}`,
      openThreads: [],
    },
  );
  assert.equal(result.notes, `测评链接：${url}`);
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
    subject: '示例网络校园招聘——校招面试邀请反馈',
    text: '请填写面试反馈问卷。面试时间：未提供。北京时间：无。',
    receivedAt: '2026-07-22T12:45:03.000Z',
  });

  assert.equal(result.eventStart, undefined);
  assert.equal(result.eventEnd, undefined);
  assert.equal(result.needsReview, true);
  assert.equal(result.notes, '面试链接：https://interview.example.test/1');
});

test('validateOutput never leaks diagnosis or evidence prose into submitted notes', () => {
  const result = validateOutput({
    ...validModelOutput,
    status: '已投递',
    eventStart: undefined,
    eventEnd: undefined,
    notes: '岗位未识别；感谢投递，已收到你的简历',
  }, {
    subject: '投递成功',
    text: '感谢投递，已收到你的简历',
  });
  assert.equal(result.notes, undefined);
});

test('validateOutput blanks process-word positions even when the subject contains them verbatim', () => {
  const input = {
    subject: '【示例社区】面试邀请',
    text: '链接：https://meeting.example.test/1',
    openThreads: openThreadsFixture,
  };
  for (const pos of ['面试邀请', '现场访客码', '测评邀请', '未提及', '应聘反馈', '简历投递成功', '面试反馈', '访客码', '投递成功']) {
    const result = validateOutput({ ...validModelOutput, position: pos }, input);
    assert.equal(result.position, '', `position "${pos}" must be blanked`);
    assert.equal(result.needsReview, true, `position "${pos}" must flag review`);
  }
});

test('validateOutput keeps a position extracted from the subject delimiter pattern', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '示例运营实习生' },
    {
      subject: '【示例社区招聘】简历投递成功 - 示例候选人 - 示例运营实习生',
      text: '',
      openThreads: openThreadsFixture,
    },
  );

  assert.equal(result.position, '示例运营实习生');
  assert.equal(result.needsReview, false);
});

test('validateOutput keeps 届次 prefixes as part of the position when they are the full position name', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const subject = '示例候选人，感谢你投递示例设备公司的2027届示例岗位丁职位';
  const result = validateOutput(
    { ...noTimeOutput, position: '2027届示例岗位丁' },
    {
      subject,
      text: '链接：https://sctrack.sendcloud.net/track/unsubscribe2.do',
      openThreads: openThreadsFixture,
    },
  );

  assert.equal(result.position, '2027届示例岗位丁');
  assert.equal(result.needsReview, false);
});

test('validateOutput leaves semantic project-versus-position judgment to the model prompt', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '2027届暑期实习' },
    { subject: '暑期项目通知', text: '项目名称由模型负责判断。', openThreads: [] },
  );
  assert.equal(result.position, '2027届暑期实习');
  assert.equal(result.needsReview, false);
});

test('validateOutput preserves model position wording except whitespace and length limits', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '  【实习】产品经理 - AI方向  ' },
    { subject: '岗位通知', text: '岗位由模型抽取。', openThreads: [] },
  );
  assert.equal(result.position, '【实习】产品经理 - AI方向');
  assert.equal(result.needsReview, false);
});

test('validateOutput keeps an empty position as empty when the email has no position', () => {
  const { eventStart, eventEnd, ...noTimeOutput } = validModelOutput;
  const result = validateOutput(
    { ...noTimeOutput, position: '' },
    { subject: '【示例社区】面试邀请', text: '链接：https://meeting.example.test/1', openThreads: openThreadsFixture },
  );

  assert.equal(result.position, '');
  assert.equal(result.needsReview, false);
});

test('extraction prompt bans process words from position and requires empty string when absent', () => {
  for (const word of ['面试邀请', '访客码', '未提及', '投递成功', '群面', '综合测评']) {
    assert.ok(EXTRACTION_PROMPT.includes(word), `流程词黑名单缺少「${word}」`);
  }
  // 「没有岗位线索时填空串」这条语义仍在，只是表述从
  // 「只有邮件原文确实没有…才返回空字符串」改成了「没有 → 填 ""」的决策结构。
  assert.match(EXTRACTION_PROMPT, /没有 → 填 ""/);
  assert.ok(
    !/才返回空字符串/.test(EXTRACTION_PROMPT),
    '旧的「才返回空字符串」表述应被单一决策标准取代',
  );
});

// isJobRelated 与 status 必须自洽：isJobRelated=false 时 status 只能是「已结束」。
//
// 回归守卫：2026-09-27 存量回填发现 HR 主动联系的面试邀请被判 isJobRelated=false
// 却带着 status=面试 落库——邮件不进进度列表却占着线程，看板上像「面了但没记录」。
// 提示词里已经写了这条约束但模型不总是遵守，所以在代码层强制。
test('a non-job-related result cannot carry a pipeline status', () => {
  for (const status of ['已投递', '测评中', '面试', 'Offer']) {
    const result = validateOutput({ ...validModelOutput, isJobRelated: false, status });
    assert.equal(result.status, '已结束', `isJobRelated=false 时 ${status} 应被降级为已结束`);
    assert.equal(result.needsReview, true, '降级必须标复核，否则页面上看不到、也没法人工改回');
  }
});

test('a non-job-related result that already says 已结束 is left alone', () => {
  // 不传 eventStart：input 里没有明确时间却带了时间，是另一条既有规则
  // （modelReturnedUnsupportedTime）会标 needsReview，与本次降级逻辑无关。
  const { eventStart, eventEnd, ...withoutTimes } = validModelOutput;
  const result = validateOutput({ ...withoutTimes, isJobRelated: false, status: '已结束' });
  assert.equal(result.status, '已结束');
  // 提示词要求 false 时 needsReview=false，不该被降级逻辑误标。
  assert.equal(result.needsReview, false);
});

test('a job-related result keeps its own status', () => {
  for (const status of ['已投递', '测评中', '面试', 'Offer', '已结束']) {
    const result = validateOutput({ ...validModelOutput, isJobRelated: true, status });
    assert.equal(result.status, status);
  }
});
