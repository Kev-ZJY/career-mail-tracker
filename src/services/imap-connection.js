import { DEFAULT_TIMEOUTS } from './deadline.js';

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function resolveProxy(env) {
  const raw = env.IMAP_PROXY || env.imap_proxy || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return undefined;
  try {
    const url = new URL(String(raw).trim());
    return ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

// Diagnostics and sync must use the same proxy, TLS identity and socket budgets.
export function buildImapOptions(profile, input, { env = process.env, timeouts = DEFAULT_TIMEOUTS } = {}) {
  const proxy = resolveProxy(env);
  return {
    host: profile.host, port: profile.port, secure: profile.secure,
    auth: { user: requiredText(input.email, 'email'), pass: requiredText(input.authorizationCode, 'authorizationCode') },
    logger: false,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.connectMs,
    socketTimeout: timeouts.fetchMs,
    ...(proxy ? { proxy } : {}),
    ...(profile.tlsServername && profile.tlsServername !== profile.host ? { tls: { servername: profile.tlsServername } } : {}),
  };
}

export async function createImapClient(options) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow(options);
}
