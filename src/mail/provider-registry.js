const MAILBOX_PROVIDERS = {
  qq: {
    id: 'qq',
    name: 'QQ 邮箱',
    host: 'imap.qq.com',
    port: 993,
    secure: true,
    webUrl: 'https://mail.qq.com/',
  },
  netease: {
    id: 'netease',
    name: '网易邮箱',
    host: 'imap.163.com',
    port: 993,
    secure: true,
    webUrl: 'https://email.163.com/',
  },
};

// 白名单：主机覆盖只放行两家邮箱自己的域，避免环境变量把连接指向任意主机
const ALLOWED_HOST_SUFFIXES = [
  'imap.qq.com',
  'imap.163.com',
  'pop.qq.com',
  'pop.163.com',
  'mail.ntes53.netease.com',
  'tencent.com',
  'netease.com',
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[?[a-fA-F0-9:]+\]?$/;

function isAllowedHostOverride(value) {
  // IP 直连用于绕过本地网关的 DNS 劫持；域名则必须落在白名单内，且只匹配后缀而非子串
  if (IPV4.test(value) || IPV6.test(value)) return true;
  const lower = value.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

function resolveEndpoint(id, env = typeof process !== 'undefined' ? process.env : {}) {
  const base = MAILBOX_PROVIDERS[id];
  if (!base) return null;
  const prefix = id === 'qq' ? 'IMAP_QQ' : 'IMAP_163';
  const legacyHostKey = id === 'qq' ? 'IMAP_HOST_QQ' : 'IMAP_HOST_163';
  const hostOverride = String(env[`${prefix}_HOST`] || env[legacyHostKey] || env.IMAP_HOST || '').trim();
  const portOverride = Number.parseInt(String(env[`${prefix}_PORT`] || '').trim(), 10);
  const secureOverride = String(env[`${prefix}_SECURE`] || '').trim().toLowerCase();

  const host = hostOverride && isAllowedHostOverride(hostOverride) ? hostOverride : base.host;
  const port = Number.isInteger(portOverride) && portOverride > 0 && portOverride < 65_536 ? portOverride : base.port;
  // 默认始终走 TLS；只有显式声明 IMAP_*_SECURE=0/false/no 才降级为明文传输
  const secure = secureOverride === ''
    ? base.secure
    : !['0', 'false', 'no', 'off'].includes(secureOverride);

  // 覆盖主机后仍用原域名做 SNI，证书校验才不会被绕过
  return { host, port, secure, tlsServername: base.host };
}

export function getMailboxProvider(id, env) {
  const provider = MAILBOX_PROVIDERS[id];
  if (!provider) throw new Error('provider must be qq or netease');
  const resolved = resolveEndpoint(id, env);
  return { ...provider, ...resolved };
}

export function listMailboxProviders() {
  return Object.values(MAILBOX_PROVIDERS).map((provider) => ({ ...provider }));
}
