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
当 isJobRelated=false 时，status 仍必须填写“已结束”（这是为了满足统一字段枚举；该记录会被系统隐藏，不应显示在招聘进度列表中），needsReview=false，nextAction 写“不写入招聘进度列表”。

【status 只能使用以下五个值】
1. 已投递：明确确认收到用户的申请/简历/投递，例如“感谢投递”“已收到你的申请”。
2. 测评中：明确要求用户完成测评、笔试、作业或在线测试；只要邮件是测评通知，就不要因为正文提到“后续 Offer”而改成 Offer。
3. 面试：明确邀请、安排、预约或确认用户参加面试/面谈/技术面/电话面。
4. Offer：明确表示录用、发放 Offer、正式聘用、薪资方案或入职意向；不能把“Offer 机会”“Offer 攻略”“欢迎投递”等广告当作 Offer。
5. 已结束：明确拒绝、未通过、暂不推进、不再推进、遗憾通知、岗位/流程关闭、申请结束，或邀请填写面试/招聘反馈问卷的邮件。拒绝不是单独的状态，统一归为已结束。
绝对不要输出“待确认”“拒绝”“筛选中”这三个状态。如果邮件属于个人流程但证据不足，仍使用最符合证据的五个状态，并将 needsReview=true、confidence 调低，在 notes 中写明缺少什么；如果完全无法确认是个人流程，则按上面的 isJobRelated=false 处理。

【冲突判断优先级】
已结束 > 测评中 > Offer > 面试 > 已投递。优先使用明确的终态/事件信号。例如“面试反馈问卷 + 流程已结束”必须是已结束；“测评 + 后续 Offer 流程”必须是测评中；“岗位推荐 + 投递入口”仍是非个人进度。

【时间与日期规则】
输入会提供邮件接收时间 receivedAt，并注明北京时间。邮件只写月/日而没有年份时，使用 receivedAt 对应的北京时间年份，绝不要擅自使用 2025 或其他年份。只在邮件明确给出时间时填写 eventStart/eventEnd；没有明确面试时间就不要编造时间，并在 notes 写“未提供明确面试时间”。测评邮件只有截止时间时，eventStart=receivedAt，eventEnd=测评截止时间；如果截止时间只有月/日，也按 receivedAt 的北京时间年份解析。时间必须是可解析的 ISO 8601 字符串，保留精确到分钟的信息。

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
  "threadRef": number | "new"（见【申请线程归属】；无把握时填 "new"）,
  "appliesTo": number[]（仅测评覆盖多岗位时填写，否则省略）,
  "eventStart": string（有明确时间时填写，否则省略）, 
  "eventEnd": string（有明确结束/截止时间时填写，否则省略）, 
  "notes": string（可选，见精简要求）
}

【position 抽取规则｜必须遵守】
position 必须是在邮件原文中明确出现的“岗位/职位名称”（例如：商业化产品运营实习生、产品运营、后端开发工程师）。常见来源：
- 主题中的职位模式：如「简历投递成功 - <候选人> - <职位名>」「面试邀请 — <职位名>」「<职位名> 一面通知」「反馈通知：<公司>-<职位名>」等，取分隔符后紧跟的职位本体；
- 正文中的职位段落：如「应聘岗位：<职位名>」「职位：<职位名>」「岗位：<职位名>」「面试岗位：<职位名>」「面试岗位：【<职位名>】」「你暂不匹配<职位名>岗位的需求」等；
- 英文邮件中的职位锚点：如 "for the role of <position>"、"position of <position>"、"your application for <position>"、"applying for the <position>"、"Interview for <position>" 等，英文职位名（如 "(Chinese Mainland) Internship Recruiting - Research & Development Summer Intern"）是有效职位，不得因语种忽略；subject 中的英文职位（如 "GE Aerospace Job Application Update: <申请号> <职位名>"）取申请号之后的职位部分。
提取要求：
1. 届次/批次信息是职位名的组成部分，必须原样保留：如「2027届暑期实习-产品运营助理」「【转正实习】产品经理岗」「产品经理（2027届实习）- 北京」都应整体作为 position 输出，不得剥离届次。只去掉公司名或渠道名前缀（如“小红书-”“实习僧”），不得去掉届次。当职位以「部门-岗位」形式出现时（如「国际事业群IBG（1）-用户与策略产品实习生」），优先把岗位名放前面，做不到不强求。
2. 剥离紧贴职位名的时间戳：如「2026-01-20 15:00:00视频用户产品实习生」→ 输出「视频用户产品实习生」；「3月12日 14:30产品运营」→ 输出「产品运营」。日期时间属于面试信息，不属于职位名。
3. 剥离批次前缀：position 前缀若是「<N年|N届>…实习生/校招/校园招聘-」这类批次声明且其后还有岗位名，只取岗位本体：如「2027实习生校园招聘-【留用实习】数据分析师-风控治理方向」→ 输出「【留用实习】数据分析师-风控治理方向」。
4. 否定式/反馈句式中的职位名同样有效，必须抽取：如「你暂不匹配C端AI产品经理实习生（Prompt Engineer 方向）岗位的需求」「很遗憾你未通过<职位名>的筛选」「感谢您应聘<职位名>岗位」中的<职位名>都是明确职位，不能因为句子是否定式就当成没有职位。这类「不匹配某岗位」「未通过筛选」的反馈邮件属于用户本人申请流程的反馈（isJobRelated=true、status=已结束），不能误判为招聘活动或岗位推荐。
5. 严禁把流程词、环节词、面试形式词或邮件主题词填进 position。以下均不是职位：面试邀请、测评邀请、视频面试、能力测评、业务面试、在线测评、面试安排、面试体验、现场访客码、访客码、面试、测评、笔试、群面、单面、一面、二面、终面、通知、反馈、应聘反馈、简历投递成功、投递成功、未提及、问卷、满意度问卷、一面通知、面试通知、测评通知、投递邀请、面试邀约、面试预约、面试确认、线上面试、现场面试、电话面试、技术面试。
6. 项目/招聘计划名不是岗位名：如「2026欧莱雅（中国）暑期实习生」「滴滴秋储实习生」「2027届暑期实习」「27届校招」都只是批次/项目名，没有具体岗位 → position 必须返回空字符串 ""。
7. 邮件中没有明确职位名（常见于只有面试链接、访客码指引、测评入口、投递成功页链接的邮件）→ position 必须返回空字符串 ""，禁止写“未提及”等占位词，禁止推测或补全。
8. 正文可能因长度限制被截断（只保留前 24000 字符），而职位常出现在正文中后段。若正文被截断，允许依据主题、发件人和可见片段中的职位线索谨慎推断职位名；若实在没有线索，position 返回空字符串 ""。

【申请线程归属】
用户消息里会附带“该公司已有的申请线程清单”，形如 #<id> <公司> <岗位>（状态：<状态>）。
1. threadRef：填清单中的数字 id 表示这封邮件属于该既有线程；填字符串 "new" 表示这是一个新申请。只能引用清单里的 id，不得凭印象编造 id。允许岗位漂移：投递岗位 A、邮件明确写着岗位 B 的面试且 B 不在清单中时，可填 "new" 并把 position 抄成邮件原文的 B。
2. appliesTo：当一封测评/笔试邮件覆盖同一家公司的多个已投递岗位（正文出现多个岗位名，或写明“全部申请岗位”“各岗位”）时，列出受影响的所有线程 id。
3. 邮件没有注明岗位名称时（常见于面试邀请、流程通知），position 必须返回空字符串 ""，绝对禁止根据公司名或上下文推测、补全岗位名称；此时优先用公司级线索通过 threadRef 归入既有线程。

【精简要求｜防冗余】
- evidence 只写 1 句、最长 80 字，必须逐字引用邮件中的关键短语，不要复述整段或重复 notes。
- notes 只有在确实有“可点击链接、截止时间缺失、低置信度原因”时才填写；无实质信息时返回空字符串 ""，不要用“无”“暂无”占位。
- notes 中禁止重复 evidence 的原句；如有多个链接用“；”分隔，单个链接直接写 URL；总长度不超过 120 字。
- nextAction 用动词开头、15 字以内（如“完成测评”“确认面试时间”）。
- 不要把泛化广告中的公司/职业硬写成个人进度。`;

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

function threadListContext(threads) {
  if (!Array.isArray(threads) || threads.length === 0) return '';
  // 上限 50 条：只当作归属线索，避免长清单把上下文撑爆
  const lines = threads
    .slice(0, 50)
    .map((thread) => `#${thread?.id} ${thread?.company || '未知公司'} ${thread?.position || '岗位未知'}（状态：${thread?.status || '未知'}）`)
    .join('\n');
  return `【当前已有的申请线程】\n${lines}\n\n请判断这封邮件属于哪个线程，在 threadRef 填该线程的数字 id，或填 "new" 表示新申请。\n\n`;
}

function hasExplicitEventTime({ subject = '', text = '' } = {}) {
  const combined = `${subject}\n${text}`;
  return /(?:\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}年\d{1,2}月\d{1,2}[日号]?\b|\b\d{1,2}月\d{1,2}[日号]?\b|\b(?:上午|下午|晚上|凌晨)\s*(?:[01]?\d|2[0-3])(?:[:：][0-5]\d|点(?:[0-5]?\d分?)?)|\b(?:[01]?\d|2[0-3])[:：][0-5]\d\b)/i.test(combined);
}

// 职位流程词黑名单：这些是邮件主题/流程/环节/面试形式词，不是岗位名称，绝不能写进 position
const POSITION_BLACKLIST = new Set([
  '面试邀请', '测评邀请', '现场访客码', '面试', '测评', '未提及', '通知', '应聘反馈',
  '简历投递成功', '面试反馈', '访客码', '简历投递', '投递成功', '反馈', '问卷', '招聘',
  '一面通知', '面试通知', '测评通知', '投递邀请', '简历更新邀请', '应聘反馈通知', '满意度问卷',
  '视频面试', '能力测评', '业务面试', '在线测评', '面试安排', '面试体验', '面试邀约',
  '线上面试', '现场面试', '电话面试', '技术面试', '群面', '单面', '一面', '二面', '终面',
  '笔试', '面试确认', '面试预约', '面试结果', '流程通知', '简历筛选', '投递反馈', '面试',
  '测评', '群面通知', '面试反馈', '招聘反馈', '人才测评', '笔试邀请', '综合能力测试',
  '校招AI编程考察', 'AI编程考察', '编程考察', '能力测试', '综合测评', '通用能力测评',
]);

// 包含上述流程词的变体（如“腾讯现场访客码”“携程能力测评”“去哪儿视频面试”），也一律拒绝
const POSITION_FLOW_WORD_RE = /(面试邀请|测评邀请|视频面试|能力测评|业务面试|在线测评|面试安排|面试体验|面试邀约|线上面试|现场面试|电话面试|技术面试|群面|单面|一面|二面|终面|笔试|访客码|未提及|投递成功|应聘反馈|满意度问卷|一面通知|面试通知|测评通知|简历评估|人才测评|面试结果|综合能力测试|AI编程考察|编程考察|能力测试|综合测评|通用能力测评)/;

// 紧贴职位名前的时间戳（如「2026-01-20 15:00:00视频用户产品实习生」「3月12日 14:30产品运营」），不属于职位名
const LEADING_TIMESTAMP_RE = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}月\d{1,2}[日号]?\s*\d{1,2}[:：]\d{2}(?::\d{2})?)[\s-]*/;

// 【】内只有「实习/校招/社招」等通用批次词时无含义，可剥离；含转正/留用/暑期/秋招等限定词时保留
const GENERIC_BRACKET_PREFIX_RE = /^【(?:实习|校招|社招|招聘|内推|应届|校园)】/;

// 批次前缀：「<N年|N届>…实习生/校招/校园招聘-」且其后还有岗位名时剥离（如「2027实习生校园招聘-【留用实习】数据分析师-风控治理方向」）
const BATCH_PREFIX_RE = /^(?:20\d{2}届?|2\d届|20\d{2}|[一二三四五六七八九十]+届)[\s-]*[^\-—-]*?(?:实习生|校招|校园招聘)\s*[-—-]\s*/;

// 具体岗位/角色词：剥离批次前缀后若不含这些词，说明只是项目/批次名，不是职位
const POSITION_ROLE_WORD_RE = /(产品|运营|开发|工程师|算法|数据(?:分析|挖掘)?|设计|测试|前端|后端|客户端|iOS|Android|销售|市场|品牌|人力|HR|财务|战略|顾问|助理|专员|经理|架构|安全|运维|质量|研发|增长|用户|策略|内容|游戏|硬件|嵌入式|机器学习|Prompt|人工智能|AI)/;

// 职位名规范化：剥离紧贴的时间戳、无含义的【】通用词前缀、批次前缀；届次/限定词原样保留
function normalizePosition(value) {
  const pos = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!pos) return '';
  let cleaned = pos
    .replace(LEADING_TIMESTAMP_RE, '')
    .replace(GENERIC_BRACKET_PREFIX_RE, '')
    .trim();
  const stripped = cleaned.replace(BATCH_PREFIX_RE, '');
  if (stripped.trim()) cleaned = stripped.trim();
  return cleaned;
}

// 批次/项目名独体：position 只剩“N年/N届+实习生/校招/项目”等批次声明、没有具体岗位词时拒绝。
// 例如「2027届暑期实习」「秋储实习生」「2026欧莱雅（中国）暑期实习生」→ 拒绝；
// 「2027届暑期实习-产品运营助理」「【留用实习】数据分析师-风控治理方向」→ 保留。
function isBatchOnlyPosition(value) {
  const pos = String(value || '').trim();
  if (!pos) return false;
  const stripped = pos
    .replace(LEADING_TIMESTAMP_RE, '')
    .replace(/^【[^】]*】/, '')                       // 去【】包装
    .replace(/^(?:20\d{2}届?|2\d届|20\d{2}|[一二三四五六七八九十]+届)\s*/, '')  // 去届次前缀
    .replace(BATCH_PREFIX_RE, '')                     // 去批次前缀
    .trim();
  if (!stripped) return true;
  return !POSITION_ROLE_WORD_RE.test(stripped);
}

function isProcessWordPosition(value) {
  const pos = String(value || '').trim();
  if (!pos) return false;
  if (POSITION_BLACKLIST.has(pos)) return true;
  if (POSITION_FLOW_WORD_RE.test(pos)) return true;
  return isBatchOnlyPosition(pos);
}

function validateOutput(value, input = {}) {
  if (!value || typeof value !== 'object') throw new Error('model output is invalid');
  if (!STATUS_VALUES.has(value.status)) throw new Error('model status is invalid');
  if (typeof value.isJobRelated !== 'boolean') throw new Error('model isJobRelated is invalid');
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) throw new Error('model confidence is invalid');
  const eventTimeIsSupported = hasExplicitEventTime(input);
  const modelReturnedUnsupportedTime = !eventTimeIsSupported && (value.eventStart || value.eventEnd);
  let notesRaw = typeof value.notes === 'string' ? value.notes.trim() : '';
  const evidenceRaw = typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 80) : '';
  // Deduplicate: if notes equals evidence or contains evidence verbatim, drop duplication
  if (notesRaw && evidenceRaw && (notesRaw === evidenceRaw || notesRaw.includes(evidenceRaw))) {
    notesRaw = '';
  }
  if (notesRaw.length > 120) notesRaw = notesRaw.slice(0, 120);
  const noteParts = notesRaw ? [notesRaw] : [];
  if (modelReturnedUnsupportedTime) noteParts.push('时间未在邮件中明确出现，已忽略。');
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
    noteParts.push('position 为流程词/邮件主题词，已置空待人工确认。');
  }

  // 防幻觉铁律：岗位名必须逐字出现在邮件原文里（subject 或正文），否则剥离并标人工复核
  const corpus = `${input.subject || ''}\n${input.text || ''}`.trim().toLowerCase();
  if (result.position && !corpus.includes(result.position.toLowerCase())) {
    result.position = '';
    result.needsReview = true;
    noteParts.push('邮件未注明岗位名称，已留空待人工确认。');
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

  if (noteParts.length) result.notes = noteParts.join(' ').slice(0, 500);
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
      const requestBody = {
        model: provider.model,
        temperature: 0,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `${threadListContext(input.openThreads)}邮件接收时间 receivedAt：${receivedAtContext(input.receivedAt)}\n发件人：${String(input.sender || '').slice(0, 1_000)}\n主题：${String(input.subject || '').slice(0, 2_000)}\n正文：${String(input.text || '').slice(0, MAX_TEXT)}` },
        ],
        response_format: { type: 'json_object' },
      };
      if (provider?.id === 'deepseek' || /api\.deepseek\.com/i.test(String(provider?.baseUrl || ''))) {
        requestBody.thinking = { type: 'disabled' };
      }
      if (provider?.id === 'openrouter' || /openrouter\.ai/i.test(String(provider?.baseUrl || ''))) {
        requestBody.max_tokens = 600;
        requestBody.reasoning = { enabled: false };
      }
      const body = JSON.stringify(requestBody);
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`model request failed with status ${response.status}`);
      const payload = await response.json();
      // 不回退原则：模型不可用/输出不合法时直接向上抛错，绝不用规则分类器兜底出结果
      return validateOutput(extractJson(responseContent(payload)), input);
    },
  };
}

export { validateOutput };
