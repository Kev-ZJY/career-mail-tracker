// Explicit model capabilities prevent provider settings from leaking into a different model.
const REASONING_ONLY_MODELS = new Set([
  'stealth/space-bunny-alpha',
]);

const DEFAULT_MAX_TOKENS = 700;
const REASONING_MAX_TOKENS = 4_000;
// One escalation for a truncated output; the mail deadline still applies.
export const TRUNCATION_RETRY_MAX_TOKENS = 16_000;

function modelId(value) {
  return String(value || '').trim();
}

/**
 * 该 provider 的模型是否强制要求 reasoning。
 * provider.reasoningEnabled 显式声明时优先（供自定义端点覆盖），否则按模型判定。
 */
export function isReasoningOnly(provider = {}) {
  if (typeof provider.reasoningEnabled === 'boolean') return provider.reasoningEnabled;
  return REASONING_ONLY_MODELS.has(modelId(provider.model));
}

/**
 * 非 reasoning 模型的输出就是一个 JSON 对象，几百 token 足够；
 * reasoning 模型的思考预算要和最终 JSON 一起算在 max_tokens 里。
 */
export function resolveMaxTokens(provider = {}) {
  if (isReasoningOnly(provider)) return REASONING_MAX_TOKENS;
  if (Number.isInteger(provider.maxTokens) && provider.maxTokens > 0) return provider.maxTokens;
  return DEFAULT_MAX_TOKENS;
}
