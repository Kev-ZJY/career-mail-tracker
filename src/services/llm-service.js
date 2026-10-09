import { buildProgressNotes } from '../domain/progress-notes.js';
import { ALLOWED_PROGRESS_STATUSES } from '../domain/statuses.js';
import { resolveCompanyName } from '../domain/company-resolver.js';
import { senderIdentityKey } from '../domain/sender-identity.js';
import { prepareBodyText } from '../domain/body-text.js';
import { isReasoningOnly, resolveMaxTokens, TRUNCATION_RETRY_MAX_TOKENS } from './model-capabilities.js';
import { DEFAULT_TIMEOUTS, withDeadline } from './deadline.js';
import { normalizeModelBaseUrl } from './model-endpoint.js';
import { redactErrorMessage } from '../domain/error-message.js';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUTS.modelMs;
const MAX_TEXT = 24_000;

export const EXTRACTION_PROMPT = `你是招聘邮件结构化解析器。判断这封邮件是否代表用户本人已参与的招聘流程，并提取字段。不得臆造公司、岗位、时间、状态。只返回一个 JSON 对象，不要解释或额外字段。

{"isJobRelated":bool,"company":string,"position":string,"status":"已投递|测评中|面试|Offer|已结束","confidence":number,"evidence":string,"nextAction":string,"needsReview":bool,"threadRef":"new","appliesToAll":bool,"eventStart":string?,"eventEnd":string?,"notes":string?}

【isJobRelated】
true 仅限用户本人已发生的招聘动作或结果：投递成功、进入测评、收到面试安排、收到录用、收到该流程的拒绝或结束通知。
false：宣讲会、招聘会、招聘活动预告；岗位推荐、职位订阅；批量营销、开放投递广告、求职攻略、课程推广、泛化校招资讯。
「火热招聘中」「立即投递」「诚邀申请」是邀请未来申请，不算。「已收到你的申请」「你已通过简历评估」算。
先找本人已发生动作的证据，找到即 true；都没有才判 false。本人进度之后附带的宣讲会、抽奖、二维码、品牌宣传不影响结果。
公司主动联系算已发生：HR 来信说「你的简历与某岗位匹配、想继续沟通后续流程」——用户虽未回复，但对方已按用户本人简历发起了流程，算 true。只有群发的岗位推荐、没有指名用户简历的才算 false。
false 时 status 填「已结束」，needsReview=false，nextAction 填「不写入招聘进度列表」。

【status】只能取这五个值：
已投递——邮件确认收到了用户的申请。
测评中——邮件要求用户做测评、笔试或作业。即使提到后续 Offer，也仍填测评中。
面试——邮件邀请、安排或确认用户参加面试。
Offer——邮件表示录用、发 offer、给薪资方案或入职意向。
已结束——拒绝、未通过、暂不推进、岗位关闭、流程结束，或邀请填写面试/招聘反馈问卷。拒绝归入已结束。
已经为用户安排好的动作被撤回时也归入已结束：面试取消、测评终止、Offer 撤销。只看这件事本身是否发生，不看句子里有没有「取消」两个字——页脚的「取消订阅」、诚信条款里的「一经发现将取消面试资格/应聘资格」都与用户本次流程无关，不能据此判已结束。
禁止输出「待确认」「拒绝」「筛选中」。
一封邮件同时命中多个时按此顺序取一个：已结束 > 测评中 > Offer > 面试 > 已投递。
注意区分主流程和附带动作：面试通知里附带「请扫描二维码完成在线测评」，主流程是面试，status 填「面试」。

【company】填本次实际用人主体。
不填：邮件服务商、ATS 或招聘平台名、部门、项目名、岗位名、发件邮箱域名。
集团和具体子公司同时出现时填更具体的那个。
邮件里有中文名就填中文名，只有英文名才填英文名。
填不出来就填 ""。

【position】填用户这次应聘的具体岗位名。这是本任务最容易出错的地方，判定标准只有一个：
问自己——邮件里有没有一句话或一个字段，把一个具体的职业角色直接连到「用户要应聘它」上？
· 有 → 填那个角色名。常见句式：「收到您对 <岗位> 的申请」「<岗位>岗位的面试」「职位/岗位名称：<岗位>」「【面试职位】：<岗位>」「试卷名称：<岗位>」。字段值读到字段结束为止，括号、破折号、斜线里的业务方向要保留。
· 没有 → 填 ""。不要用公司名、批次名、活动名去凑。
必须排除的词（这些是流程或考试形式，不是岗位）：群面、无领导小组、综合测评、人才测评、在线测评、测评邀请、面试邀请、视频面试、业务面试、笔试、笔试邀请、现场访客码、访客码、通知、反馈、投递成功、未提及、问卷、一面、二面、终面。
容易误判的一种情况：「<招聘批次>-<角色>试卷-<日期>」是给所有考生用的批量试卷名，不代表某个人投了这个岗位，填 ""。但如果整封邮件只服务于收件人一个人（以「尊敬的 <姓名>」开头，全文只讲这一份申请），那试卷名里的角色就是他的岗位，应当填上。
只省掉纯冗余的部分：开头重复的公司名、结尾重复的「岗位/职位」字样、届次与招聘年份（如「2027届」）、校招批次。
部门、业务方向、城市不是冗余——它们区分同一个公司的不同岗位，省掉就认不出投的是哪个岗，要保留（如「研发部工程师（示例城市）」原样填，不要压成「工程师」）。
反过来，保留规则也不等于宽松：邮件点名了项目、计划、专项的名称而这就是用户投的那个项目时，照填（如「示例全球培训计划（Example Global Program）」填成它，不要因为名字里没有「岗位」二字就留空）。只有邮件确实没给出任何角色名时，才填 ""。
英文岗位同样要填。后半段附带的宣讲或营销内容不能改掉前面已经明确的岗位。

【时间】邮件只写月/日没有年份时，用输入里 receivedAt 的北京时间年份。只在邮件明确给出时间时填 eventStart/eventEnd。测评只给截止时间时 eventStart=receivedAt、eventEnd=截止时间。格式必须是可解析的 ISO 8601。没有明确面试时间就不要编造。

【threadRef】固定填 "new"。历史申请由系统在本地归并，不要输出历史线程编号。只当测评邮件写了「全部申请岗位」「所有已投递岗位」这类覆盖范围时 appliesToAll=true。

【evidence】一句话、80 字以内，逐字引用邮件里的关键短语。
【notes】已投递、Offer、已结束填 ""；测评中最多填一个测评链接，截止时间写进 eventEnd；面试最多填一个面试链接。禁止写「岗位未识别」或低置信度原因。
【nextAction】动词开头，15 字以内，例如「完成测评」「确认面试时间」。`;

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

function mailContext(input) {
  // 正文先剥内嵌 base64 图片再截断：截断额度不能被二维码垃圾占满，
  // 否则真正含岗位信息的正文会被切掉。详见 domain/body-text.js。
  return `邮件接收时间 receivedAt：${receivedAtContext(input.receivedAt)}\n发件人：${String(input.sender || '').slice(0, 1_000)}\n主题：${String(input.subject || '').slice(0, 2_000)}\n正文：${prepareBodyText(input.text, MAX_TEXT)}`;
}

function hasExplicitEventTime({ subject = '', text = '' } = {}) {
  const combined = `${subject}\n${text}`;
  return /(?:\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}年\d{1,2}月\d{1,2}[日号]?\b|\b\d{1,2}月\d{1,2}[日号]?\b|\b(?:上午|下午|晚上|凌晨)\s*(?:[01]?\d|2[0-3])(?:[:：][0-5]\d|点(?:[0-5]?\d分?)?)|\b(?:[01]?\d|2[0-3])[:：][0-5]\d\b)/i.test(combined);
}

// 这里只拦截完全等于通用占位词的输出；岗位语义正确性由模型完成。
const POSITION_BLACKLIST = new Set([
  '面试邀请', '测评邀请', '现场访客码', '面试', '测评', '未提及', '通知', '应聘反馈',
  '简历投递成功', '面试反馈', '访客码', '简历投递', '投递成功', '反馈', '问卷', '招聘',
  '职位', '职位名称', '岗位', '岗位名称', '一面通知', '面试通知', '测评通知', '投递邀请',
  '简历更新邀请', '应聘反馈通知', '满意度问卷', '视频面试', '能力测评', '业务面试', '在线测评', '面试安排',
  '面试体验', '面试邀约', '线上面试', '现场面试', '电话面试', '技术面试', '群面', '单面',
  '一面', '二面', '终面', '笔试', '面试确认', '面试预约', '面试结果', '流程通知',
  '简历筛选', '投递反馈', '群面通知', '招聘反馈', '人才测评', '笔试邀请', '综合能力测试', 'AI编程考察',
  '编程考察', '能力测试', '综合测评', '通用能力测评',
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
  if (!ALLOWED_PROGRESS_STATUSES.has(value.status)) throw new Error('model status is invalid');
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
  // Conflicting non-recruitment outputs stay out of the timeline and require review.
  if (!result.isJobRelated && result.status !== '已结束') {
    result.status = '已结束';
    result.needsReview = true;
  }
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

function modelResponseError(payload, status) {
  const upstreamCode = Number(payload?.error?.code);
  const effectiveStatus = status === 200 && Number.isInteger(upstreamCode) && upstreamCode >= 400 ? upstreamCode : status === 200 ? 503 : status;
  const rawDetail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message;
  const detail = redactErrorMessage(rawDetail);
  const failures = {
    400: ['MODEL_CONFIG_INVALID', '模型请求参数不被支持，请检查模型与接口配置'],
    401: ['MODEL_AUTH_FAILED', '模型认证失败，请检查 API key'],
    402: ['MODEL_PAYMENT_REQUIRED', '模型账户额度不足'],
    403: ['MODEL_ACCESS_DENIED', '模型访问被拒绝，请检查账户权限与供应商限制'],
    404: ['MODEL_NOT_FOUND', '模型或接口不可用（404），请检查兼容协议地址、模型名称及可用端点'],
    429: ['MODEL_RATE_LIMITED', '模型额度或调用频率已达上限'],
  };
  const [code, message] = failures[effectiveStatus] || ['MODEL_REQUEST_FAILED', `模型上游请求失败（${effectiveStatus}）`];
  return Object.assign(new Error(`${message}${detail ? `：${detail}` : ''}`), { code, status: effectiveStatus });
}

// 不同上游对「是否允许关闭 reasoning」的要求相反：DeepSeek 走 thinking.disabled，
// OpenRouter 上的多数模型可以显式关闭，但 reasoning-only 端点**强制要求** reasoning，
// 下发 reasoning:{enabled:false} 会直接 400（判定见 model-capabilities.js）。
function isOpenRouter(provider) {
  return provider?.id === 'openrouter' || /openrouter\.ai/i.test(String(provider?.baseUrl || ''));
}

function buildRequestOverrides(provider) {
  const overrides = {};
  if (provider?.id === 'deepseek' || /api\.deepseek\.com/i.test(String(provider?.baseUrl || ''))) {
    overrides.thinking = { type: 'disabled' };
  }
  if (isOpenRouter(provider)) {
    // reasoning-only 端点不允许下发 reasoning:{enabled:false}（会 400），
    // 此时完全不下发该字段，由服务端默认开启。
    if (!isReasoningOnly(provider)) {
      if (provider.reasoning !== undefined) overrides.reasoning = provider.reasoning;
      else overrides.reasoning = { enabled: false };
    }
  }
  return overrides;
}

export function createLlmClassifier({
  provider,
  credentialStore,
  rules = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return {
    async checkConnection({ signal } = {}) {
      // Only transient transport / upstream failures retry, within the caller's probe deadline.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { return await this.classify({}, { signal, connectivityOnly: true }); }
        catch (error) {
          if (signal?.aborted || attempt === 2 || !(error.code === 'MODEL_REQUEST_FAILED' && error.status >= 500)) throw error;
          await delay(250 * (attempt + 1), undefined, { signal });
        }
      }
    },
    async classify(input = {}, { signal = input.signal, connectivityOnly = false } = {}) {
      const baseUrl = normalizeModelBaseUrl(provider?.baseUrl);
      const apiKey = provider?.credentialRef ? credentialStore?.get(provider.credentialRef) : null;
      if (provider?.credentialRequired !== false && provider?.id !== 'ollama' && !apiKey) {
        throw Object.assign(new Error('model credential is not configured'), { code: 'MODEL_AUTH_FAILED' });
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
        const overrides = buildRequestOverrides(provider);
        // 只有 OpenRouter 侧需要显式 max_tokens；reasoning-only 端点无论挂在哪都必须显式下发，
        // 否则会用服务端默认值，思考 token 挤掉最终 JSON。
        if (isOpenRouter(provider) || isReasoningOnly(provider)) {
          requestBody.max_tokens = maxTokens;
        }
        Object.assign(requestBody, overrides);
        let payload;
        try {
          payload = await withDeadline(async (requestSignal) => {
            const response = await fetchImpl(`${baseUrl}/chat/completions`, {
              method: 'POST', headers, body: JSON.stringify(requestBody), signal: requestSignal,
            });
            if (!response.ok) {
              let upstream;
              try { upstream = await response.json(); } catch { /* Non-JSON error pages still have an HTTP status. */ }
              throw modelResponseError(upstream, response.status);
            }
            const result = await response.json();
            if (result?.error) throw modelResponseError(result, response.status);
            return result;
          }, { timeoutMs, signal, code: 'MODEL_TIMEOUT', label: '模型请求与响应读取' });
        } catch (cause) {
          // AbortSignal.timeout 抛 DOMException{name:'TimeoutError'}，不带 code。
          // 标记后上层可区分「上游卡死」与「网络抖动」——前者重试没有意义。
          if (!cause?.code && (cause?.name === 'TimeoutError' || cause?.name === 'AbortError')) {
            const error = new Error(`model request timed out after ${timeoutMs}ms`);
            error.code = 'MODEL_TIMEOUT';
            error.cause = cause;
            throw error;
          }
          throw cause;
        }
        // A truncated response is invalid even when it contains a partial JSON object.
        if (payload?.choices?.[0]?.finish_reason === 'length') {
          const error = new Error('model output was truncated by the max_tokens budget');
          error.code = 'MODEL_OUTPUT_TRUNCATED';
          error.finishReason = 'length';
          error.contentChars = String(payload?.choices?.[0]?.message?.content || '').length;
          throw error;
        }
        try {
          return extractJson(responseContent(payload));
        } catch (cause) {
          // 只在「完全没拿到内容」时算截断；内容存在但 JSON 不合法仍按可重试处理。
          if (!String(responseContent(payload)).trim()) {
            const error = new Error('model returned no usable content');
            error.code = 'MODEL_OUTPUT_TRUNCATED';
            error.cause = cause;
            throw error;
          }
          throw cause;
        }
      };

      if (connectivityOnly) {
        const pong = await requestModel({ system: '只返回一个 JSON 对象：{"ok":true}', user: '确认当前模型可以正常响应。', maxTokens: resolveMaxTokens(provider) });
        if (pong?.ok !== true) throw Object.assign(new Error('模型连通性确认未返回有效 JSON'), { code: 'MODEL_PREFLIGHT_FAILED' });
        return { ok: true };
      }

      // Increase the output budget once for truncation, within the whole-mail deadline.
      const requestWithEscalation = async (request) => {
        const baseMaxTokens = resolveMaxTokens(provider);
        try {
          return await requestModel({ ...request, maxTokens: baseMaxTokens });
        } catch (error) {
          if (error?.code !== 'MODEL_OUTPUT_TRUNCATED') throw error;
          if (baseMaxTokens >= TRUNCATION_RETRY_MAX_TOKENS) throw error;
          return requestModel({ ...request, maxTokens: TRUNCATION_RETRY_MAX_TOKENS });
        }
      };

      const analysisRaw = await requestWithEscalation({
        system: EXTRACTION_PROMPT,
        user: mailContext(input),
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
      return result;
    },
  };
}

export { validateOutput };
