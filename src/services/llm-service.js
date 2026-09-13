import { buildProgressNotes } from '../domain/progress-notes.js';
import { resolveCompanyName } from '../domain/company-resolver.js';
import { senderIdentityKey } from '../domain/sender-identity.js';

const STATUS = {
  submitted: '已投递',
  assessment: '测评中',
  interview: '面试',
  offer: 'Offer',
  ended: '已结束',
};

const STATUS_VALUES = new Set(Object.values(STATUS));
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TEXT = 24_000;

export const EXTRACTION_PROMPT = `你是“本地求职进度追踪器”的招聘邮件结构化解析器。你的任务是判断一封邮件是否代表“用户本人已经参与的某个招聘申请流程”，并提取它对招聘进度有用的信息。你只能根据输入的发件人、主题、正文和接收时间判断，不能臆测不存在的公司、职位、时间或状态。

【输出纪律】
只返回一个合法的 JSON 对象，不要 Markdown、解释、思维过程、前后缀或额外字段。所有字符串使用中文或邮件原文中的专有名词。confidence 必须是 0 到 1 的数字；证据必须引用邮件中实际出现的关键信号。

【第一道判断：是否属于个人招聘进度】
isJobRelated=true 仅适用于用户本人已经投递、申请、进入测评、收到面试安排、收到录用结果，或收到该申请流程结束/未通过通知的邮件。
以下邮件不属于个人招聘进度，必须返回 isJobRelated=false，不能创建或更新某个公司的招聘进度：招聘活动、宣讲会、招聘会、双选会、招聘峰会、招聘活动预告；招聘网站的岗位推荐、职位订阅、职位提醒、热招岗位推送；批量营销、开放投递广告、求职/申请攻略、培训/课程推广、泛化的校园招聘资讯。邮件里出现“招聘”“岗位”“投递”等词，不代表它就是用户本人申请进度。
“火热招聘中”“诚邀加入/申请”“立即投递”“申请截止日期”“面向应届生”等是在邀请收件人未来申请，不代表收件人已经完成申请；营销邮件用“你/您/同学”称呼收件人也不是个人进度证据。只有完成时或已发生的个人动作/结果（例如“已收到你的申请”“你已通过简历评估”）才能据此判为 true。
判断顺序必须是：先在全文查找“已收到你的申请/简历”“感谢申请/投递”“邀请你完成测评/参加面试”“申请未通过”等指向用户本人的完成时进度证据；只要存在这类证据，isJobRelated 就是 true。只有全文都没有个人进度证据时，才根据活动、宣讲、推广或岗位推荐判断 false。招聘邮件在个人申请确认之后附带宣讲会、抽奖、二维码或品牌宣传很常见，这些尾部内容不得把前面的个人申请进度覆盖成 false。
当 isJobRelated=false 时，status 仍必须填写“已结束”（这是为了满足统一字段枚举；该记录会被系统隐藏，不应显示在招聘进度列表中），needsReview=false，nextAction 写“不写入招聘进度列表”。

【status 只能使用以下五个值】
1. 已投递：明确确认收到用户的申请/简历/投递，例如“感谢投递”“已收到你的申请”。
2. 测评中：明确要求用户完成测评、笔试、作业或在线测试；只要邮件是测评通知，就不要因为正文提到“后续 Offer”而改成 Offer。
3. 面试：明确邀请、安排、预约或确认用户参加面试/面谈/技术面/电话面。
4. Offer：明确表示录用、发放 Offer、正式聘用、薪资方案或入职意向；不能把“Offer 机会”“Offer 攻略”“欢迎投递”等广告当作 Offer。
5. 已结束：明确拒绝、未通过、暂不推进、不再推进、遗憾通知、岗位/流程关闭、申请结束，或邀请填写面试/招聘反馈问卷的邮件。拒绝不是单独的状态，统一归为已结束。
绝对不要输出“待确认”“拒绝”“筛选中”这三个状态。如果邮件属于个人流程但证据不足，仍使用最符合证据的五个状态，并将 needsReview=true、confidence 调低；不要把缺失项或低置信度原因写进 notes。如果完全无法确认是个人流程，则按上面的 isJobRelated=false 处理。

【冲突判断优先级】
已结束 > 测评中 > Offer > 面试 > 已投递。优先使用明确的终态/事件信号。例如“面试反馈问卷 + 流程已结束”必须是已结束；“测评 + 后续 Offer 流程”必须是测评中；“岗位推荐 + 投递入口”仍是非个人进度。

【时间与日期规则】
输入会提供邮件接收时间 receivedAt，并注明北京时间。邮件只写月/日而没有年份时，使用 receivedAt 对应的北京时间年份，绝不要擅自使用 2025 或其他年份。只在邮件明确给出时间时填写 eventStart/eventEnd；没有明确面试时间就不要编造时间。测评邮件只有截止时间时，eventStart=receivedAt，eventEnd=测评截止时间；如果截止时间只有月/日，也按 receivedAt 的北京时间年份解析。时间必须是可解析的 ISO 8601 字符串，保留精确到分钟的信息。

【字段契约】
必须返回以下字段：
{
  "isJobRelated": boolean,
  "company": string,
  "position": string,
  "status": "已投递" | "测评中" | "面试" | "Offer" | "已结束",
  "confidence": number,
  "evidence": string,
  "nextAction": string,
  "needsReview": boolean,
  "threadRef": "new"（历史申请由系统在本地归并，不要猜测编号）,
  "appliesToAll": boolean（仅测评邮件明确覆盖本人已投递的全部岗位时为 true，否则 false；不需要知道历史线程）,
  "eventStart": string（有明确时间时填写，否则省略）, 
  "eventEnd": string（有明确结束/截止时间时填写，否则省略）, 
  "notes": string（可选，见精简要求）
}

【company 抽取与统一｜必须遵守】
1. 综合发件人显示名、主题、正文中的申请对象与落款提取本次实际用人/招聘主体。发件人显示名是明确的公司或招聘品牌时属于强证据；除非正文明确说明用户申请的是另一用人单位，否则不要被岗位、项目或计划名中看似公司的词覆盖。
2. 不把邮件服务商、ATS/招聘平台、部门、项目团队、招聘计划、岗位名或发件邮箱域名直接当成公司。上级集团与本次明确招聘的子公司、研究院、研究所或事业单位同时出现时，优先最具体的用人单位。
3. 公司同时出现中文名和英文名时，company 必须优先输出最明确的中文名称；只有邮件全文确实没有中文名称时才输出英文名称。即使发件人显示名是英文品牌，只要主题、正文申请对象或落款明确给出同一主体的中文名，也必须返回中文名，不能因为发件人排在最前面就保留英文名。
4. 只根据本封邮件判断招聘主体。集团母公司、旗下独立子公司、不同事业品牌不能仅因共享集团字样就算同一主体；公司名称的历史统一由系统在本地完成。
5. 邮件无法确认公司时 company 返回空字符串，不从岗位或历史记录猜造。

公司边界：发件人显示名是招聘主体，而正文仅在项目或计划名中出现另一个组织词时，不要仅凭该词改写 company；集团与明确负责本次招聘的下属单位同时出现时，选择下属单位；同一主体同时有中文与英文名称时，优先输出邮件中的中文名称。

【position 抽取规则｜必须遵守】
position 是用户这次申请的具体岗位名称。你需要完整阅读主题和正文后进行语义提取，而不是依赖固定模板或只看某一行。
先在内部列出所有看起来像角色名称的片段，再区分它们与用户申请的关系：只有被“申请、应聘、投递、收到申请、面试岗位”等语义直接指向的片段才是岗位；位于试卷、测评、考试、活动或项目名称中的片段不是岗位。不要输出这份内部列表。
1. 最高优先级检查“收到您对 <职位名> 的申请”“申请/应聘/投递 <职位名>”“职位/岗位名称：<职位名>”等能把用户申请动作与具体角色直接连接起来的语义。“职位/岗位名称”字段后的值必须完整读取到该字段结束，括号、破折号或斜线中的业务方向不得删除。岗位可能位于主题、申请确认段、面试/测评说明、拒绝说明、中英文句子或较长段落中；否定句中的岗位仍是有效岗位，例如“未通过 <职位名> 的筛选”。邮件后半段即使附带宣讲、活动或营销内容，也不能覆盖前文已经明确的个人申请岗位。
2. 邮件明确出现具体岗位时，position 不得返回空字符串。输出岗位本体即可；允许省略公司名、部门冗余、城市、届次、招聘年份、校招批次和重复的“岗位/职位”后缀，也要剔除紧贴在岗位前后的日期时间、候选人姓名和申请编号。不要因为不能逐字照抄整段长名称而放弃岗位；必须保留能区分岗位的核心名称与方向。
3. 英文岗位同样必须提取并保留必要方向，不得因为岗位较长或邮件为英文而留空。
4. 纯招聘批次、校园招聘项目、活动名、测评名称、试卷名称、考试科目、流程阶段和面试形式不是具体岗位。特别注意：角色词若只出现在试卷、测评或考试名称中，它仍然只是流程标签，position 必须为 ""。正文只说“意向岗位或调剂岗位涉及笔试”也没有给出具体岗位。若项目或计划名称本身包含具体职业角色，且邮件明确表示用户已参与该角色的个人申请流程，仍应提取这个角色；没有具体职业角色的项目名才留空。
5. 严禁把面试邀请、测评邀请、视频面试、能力测评、业务面试、在线测评、面试安排、访客码、面试、测评、笔试、群面、一面、二面、终面、通知、反馈、投递成功、未提及、问卷等流程词填入 position。
6. 只有邮件原文确实没有具体岗位时，position 才返回空字符串 ""。此时禁止根据公司或常识补全。
7. 正文最多提供前 24000 字符。若可见内容已出现岗位就必须提取；若全部可见内容都没有具体岗位，则返回空字符串，不以 needsReview 代替岗位提取。
8. 非空 position 必须通过必要条件：邮件中存在一句话或一个字段，明确表达“用户申请/应聘/投递/面试的是这个角色”。邀请参加考试只能证明流程状态，不能证明试卷标题里的角色就是申请岗位；试卷名称、测评名称、考试名称永远不能满足这个必要条件。
9. 返回 JSON 前必须在内部做双向复核：如果准备返回空 position，重新查找用户申请动作是否直接带出具体角色；如果准备返回非空 position，逐字回答“邮件哪句话明确说用户申请的是这个角色”。若答案只能引用试卷/测评/考试/项目/活动名称，必须把 position 改成 ""。不要输出复核过程，也不要增加字段。

【申请线程归属】
本次输入不包含历史申请线程。threadRef 固定返回 "new"，不要输出不存在的线程编号，也不要输出 appliesTo。若测评邮件明确写“全部申请岗位”“所有已投递岗位”等覆盖范围，则 appliesToAll=true；仅提到一个岗位或无法确认覆盖范围时为 false。系统会在本地根据公司、岗位和进度归并申请；这不影响你在同一次请求中完整提取本封邮件的公司、岗位、状态和时间。

【精简要求｜防冗余】
- evidence 只写 1 句、最长 80 字，必须逐字引用邮件中的关键短语，不要复述整段或重复 notes。
- notes 不是分析解释栏：已投递、Offer、已结束的 notes 必须返回空字符串 ""。
- 测评中的 notes 最多只写一个可点击的测评/笔试链接；测评截止时间写入 eventEnd，由系统统一展示。
- 面试的 notes 最多只写一个可点击的面试/会议链接。
- 备注禁止出现邮件原文摘录、“岗位未识别/待确认”、时间缺失、低置信度原因或 evidence 的重复内容；没有上述允许链接时返回空字符串 ""。
- nextAction 用动词开头、15 字以内（如“完成测评”“确认面试时间”）。
- 不要把泛化广告中的公司/职业硬写成个人进度。

【输出前最后检查｜优先级最高】
- 先忽略纯试卷名称、纯测评名称、纯考试名称、招聘活动名和不含职业角色的项目名，再判断邮件是否仍明确写出了用户申请的具体岗位。不要机械忽略“申请/应聘/投递”的直接宾语：如果该宾语包含明确职业角色，它就是岗位候选，即使名称里还含品牌、计划、项目或括号说明。
- 如果忽略这些名称后没有具体岗位，position 必须是 ""；“意向岗位/调剂岗位”只是泛称，不是具体岗位。
- 如果忽略这些名称后仍有“申请/应聘/投递 <具体岗位>”“收到对 <具体岗位> 的申请”等直接关系，必须提取该岗位，不能留空。
- “我们已收到您对 <具体岗位> 的申请”必须提取该岗位的完整角色与方向；不得仅因名称像人才计划或带括号说明而置空。
- 边界示例：“您投递的意向岗位如涉及笔试，请完成考试。试卷名称：<招聘批次>-<角色词>试卷-<日期>。”应输出 position=""，因为角色词只属于试卷名称。
- 正向示例：“我们已收到您对 <具体岗位> 的申请。下方是宣讲会和抽奖信息。”应输出 position="<具体岗位>"，因为申请动作直接连接具体岗位，后续宣传不能覆盖它。
- 本检查覆盖前文中任何可能产生歧义的说明。`;

function cleanBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('model baseUrl is required');
  return value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}

function extractJson(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model response is not JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function receivedAtContext(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '未知（请不要自行推断年份）';
  const date = new Date(value);
  const beijing = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
  return `${value}；北京时间：${beijing}`;
}

function mailContext(input, suffix = '') {
  return `邮件接收时间 receivedAt：${receivedAtContext(input.receivedAt)}\n发件人：${String(input.sender || '').slice(0, 1_000)}\n主题：${String(input.subject || '').slice(0, 2_000)}\n正文：${String(input.text || '').slice(0, MAX_TEXT)}${suffix}`;
}

function hasExplicitEventTime({ subject = '', text = '' } = {}) {
  const combined = `${subject}\n${text}`;
  return /(?:\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}年\d{1,2}月\d{1,2}[日号]?\b|\b\d{1,2}月\d{1,2}[日号]?\b|\b(?:上午|下午|晚上|凌晨)\s*(?:[01]?\d|2[0-3])(?:[:：][0-5]\d|点(?:[0-5]?\d分?)?)|\b(?:[01]?\d|2[0-3])[:：][0-5]\d\b)/i.test(combined);
}

// 这里只拦截完全等于通用占位词的输出；岗位语义正确性由模型完成。
const POSITION_BLACKLIST = new Set([
  '面试邀请', '测评邀请', '现场访客码', '面试', '测评', '未提及', '通知', '应聘反馈',
  '简历投递成功', '面试反馈', '访客码', '简历投递', '投递成功', '反馈', '问卷', '招聘',
  '职位', '职位名称', '岗位', '岗位名称',
  '一面通知', '面试通知', '测评通知', '投递邀请', '简历更新邀请', '应聘反馈通知', '满意度问卷',
  '视频面试', '能力测评', '业务面试', '在线测评', '面试安排', '面试体验', '面试邀约',
  '线上面试', '现场面试', '电话面试', '技术面试', '群面', '单面', '一面', '二面', '终面',
  '笔试', '面试确认', '面试预约', '面试结果', '流程通知', '简历筛选', '投递反馈', '面试',
  '测评', '群面通知', '面试反馈', '招聘反馈', '人才测评', '笔试邀请', '综合能力测试',
  'AI编程考察', '编程考察', '能力测试', '综合测评', '通用能力测评',
]);

function normalizePosition(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
}

function isProcessWordPosition(value) {
  const pos = String(value || '').trim();
  if (!pos) return false;
  return POSITION_BLACKLIST.has(pos);
}

function validateOutput(value, input = {}, rules = {}) {
  if (!value || typeof value !== 'object') throw new Error('model output is invalid');
  if (!STATUS_VALUES.has(value.status)) throw new Error('model status is invalid');
  if (typeof value.isJobRelated !== 'boolean') throw new Error('model isJobRelated is invalid');
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) throw new Error('model confidence is invalid');
  const eventTimeIsSupported = hasExplicitEventTime(input);
  const modelReturnedUnsupportedTime = !eventTimeIsSupported && (value.eventStart || value.eventEnd);
  let notesRaw = typeof value.notes === 'string' ? value.notes.trim() : '';
  const evidenceRaw = typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 80) : '';
  if (notesRaw.length > 4_000) notesRaw = notesRaw.slice(0, 4_000);
  const result = {
    isJobRelated: value.isJobRelated,
    company: typeof value.company === 'string' ? value.company.trim() : '',
    position: normalizePosition(value.position),
    status: value.status,
    confidence: Math.min(1, Math.max(0, confidence)),
    evidence: evidenceRaw,
    nextAction: typeof value.nextAction === 'string' ? value.nextAction.trim().slice(0, 30) : '',
    needsReview: Boolean(value.needsReview) || Boolean(modelReturnedUnsupportedTime),
  };
  const eventStart = eventTimeIsSupported ? validIso(value.eventStart) : undefined;
  const eventEnd = eventTimeIsSupported ? validIso(value.eventEnd) : undefined;
  if (eventStart) result.eventStart = eventStart;
  if (eventEnd) result.eventEnd = eventEnd;

  // 流程词黑名单：position 不能是邮件主题/流程词（面试邀请、访客码等），命中则置空并标复核
  if (result.position && isProcessWordPosition(result.position)) {
    result.position = '';
    result.needsReview = true;
  }

  // 线程归属：只放行 "new" 或确实存在于 openThreads 的整型 id，其余一律剥离
  const knownThreadIds = new Set(
    (Array.isArray(input.openThreads) ? input.openThreads : [])
      .map((thread) => thread?.id)
      .filter((id) => Number.isInteger(id)),
  );
  if (value.threadRef === 'new' || (Number.isInteger(value.threadRef) && knownThreadIds.has(value.threadRef))) {
    result.threadRef = value.threadRef;
  }
  if (Array.isArray(value.appliesTo)) {
    const appliesTo = value.appliesTo.filter((id) => Number.isInteger(id) && knownThreadIds.has(id));
    if (appliesTo.length) result.appliesTo = appliesTo;
  }
  if (result.status === '测评中' && value.appliesToAll === true) result.appliesToAll = true;

  result.company = resolveCompanyName({
    company: result.company,
    threadRef: result.threadRef,
    openThreads: input.openThreads,
    aliases: rules.companyAliases,
  });

  const notes = buildProgressNotes({
    status: result.status,
    notes: notesRaw,
    eventEnd: result.eventEnd,
  });
  if (notes) result.notes = notes;
  return result;
}

function responseContent(payload) {
  return payload?.choices?.[0]?.message?.content
    || payload?.message?.content
    || payload?.response
    || '';
}

export function createLlmClassifier({
  provider,
  credentialStore,
  rules = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return {
    async classify(input = {}) {
      const baseUrl = cleanBaseUrl(provider?.baseUrl);
      const apiKey = provider?.credentialRef ? credentialStore?.get(provider.credentialRef) : null;
      if (provider?.credentialRequired !== false && provider?.id !== 'ollama' && !apiKey) {
        throw new Error('model credential is not configured');
      }
      if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const requestModel = async ({ system, user, maxTokens }) => {
        const requestBody = {
          model: provider.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
        };
        if (provider?.id === 'deepseek' || /api\.deepseek\.com/i.test(String(provider?.baseUrl || ''))) {
          requestBody.thinking = { type: 'disabled' };
        }
        if (provider?.id === 'openrouter' || /openrouter\.ai/i.test(String(provider?.baseUrl || ''))) {
          requestBody.max_tokens = maxTokens;
          requestBody.reasoning = { enabled: false };
        }
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`model request failed with status ${response.status}`);
          error.status = response.status;
          if (response.status === 429) error.code = 'MODEL_RATE_LIMITED';
          throw error;
        }
        return extractJson(responseContent(await response.json()));
      };

      const analysisRaw = await requestModel({
        system: EXTRACTION_PROMPT,
        user: mailContext(input),
        maxTokens: 700,
      });
      const rawCompany = typeof analysisRaw.company === 'string'
        ? analysisRaw.company.trim().slice(0, 200)
        : '';
      let canonicalCompany = resolveCompanyName({
        company: rawCompany,
        openThreads: input.openThreads,
        aliases: rules.companyAliases,
      });
      const currentSenderIdentity = senderIdentityKey(input.sender);
      if (currentSenderIdentity) {
        const senderCompanies = [...new Set(
          (Array.isArray(input.openThreads) ? input.openThreads : [])
            .filter((thread) => senderIdentityKey(thread?.latestSender) === currentSenderIdentity)
            .map((thread) => String(thread?.company || '').trim())
            .filter(Boolean),
        )];
        if (senderCompanies.length === 1) canonicalCompany = senderCompanies[0];
      }
      // 不回退原则：模型不可用/输出不合法时直接向上抛错，绝不用规则分类器兜底出结果
      const result = validateOutput(
        { ...analysisRaw, company: canonicalCompany, threadRef: 'new', appliesTo: undefined },
        input,
        rules,
      );
      if (result.position && isProcessWordPosition(result.position)) {
        result.position = '';
        result.needsReview = true;
      }
      return result;
    },
  };
}

export { validateOutput };
