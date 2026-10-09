export function normalizeModelBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch {
    throw Object.assign(new Error('模型接口地址必须是有效的 HTTP / HTTPS URL'), { code: 'MODEL_CONFIG_INVALID' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('模型接口地址仅支持 HTTP / HTTPS，不应包含凭据、查询参数或片段'), { code: 'MODEL_CONFIG_INVALID' });
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return url.href.replace(/\/+$/, '');
}
