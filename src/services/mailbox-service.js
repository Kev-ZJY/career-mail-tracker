import { getMailboxProvider } from '../mail/provider-registry.js';
import { DEFAULT_TIMEOUTS, withDeadline } from './deadline.js';
import { buildImapOptions, createImapClient } from './imap-connection.js';

export function createMailboxService({
  providerRegistry = getMailboxProvider,
  clientFactory = createImapClient,
  env = process.env,
  timeouts: timeoutOverrides = {},
} = {}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...timeoutOverrides };
  return {
    async testConnection(input, { signal } = {}) {
      const profile = providerRegistry(input.provider);
      const options = buildImapOptions(profile, input, { env, timeouts });
      const client = await withDeadline(() => clientFactory(options), { timeoutMs: timeouts.connectMs, signal, code: 'IMAP_CONNECT_TIMEOUT', label: '创建邮箱连接' });
      client.on?.('error', () => {});
      const close = () => { try { client.close?.(); } catch { /* already closed */ } };
      signal?.addEventListener('abort', close, { once: true });
      try {
        await withDeadline(() => client.connect(), { timeoutMs: timeouts.connectMs, signal, code: 'IMAP_CONNECT_TIMEOUT', label: '邮箱连接' });
        return {
          ok: true,
          provider: profile.id,
          email: options.auth.user,
          host: profile.host,
          mailbox: 'INBOX',
        };
      } catch (error) {
        close();
        return {
          ok: false,
          provider: profile.id,
          email: options.auth.user,
          code: error?.code || 'IMAP_CONNECTION_FAILED',
          message: error instanceof Error ? error.message : 'IMAP connection failed',
        };
      } finally {
        signal?.removeEventListener('abort', close);
        if (typeof client.logout === 'function') {
          try { await withDeadline(() => client.logout(), { timeoutMs: timeouts.logoutMs, code: 'IMAP_LOGOUT_TIMEOUT', label: '退出邮箱连接' }); } catch { close(); }
        }
      }
    },
  };
}
