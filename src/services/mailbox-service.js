import { getMailboxProvider } from '../mail/provider-registry.js';

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value.trim();
}

async function defaultClientFactory(options) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow(options);
}

export function createMailboxService({
  credentialStore,
  providerRegistry = getMailboxProvider,
  clientFactory = defaultClientFactory,
} = {}) {
  if (!credentialStore) throw new Error('credentialStore is required');

  function buildConnectionOptions({ provider, email, authorizationCode }) {
    const profile = providerRegistry(provider);
    return {
      profile,
      options: {
        host: profile.host,
        port: profile.port,
        secure: profile.secure,
        auth: { user: requiredText(email, 'email'), pass: requiredText(authorizationCode, 'authorizationCode') },
        logger: false,
      },
    };
  }

  return {
    buildConnectionOptions,

    async testConnection(input) {
      const { profile, options } = buildConnectionOptions(input);
      const client = await clientFactory(options);
      try {
        await client.connect();
        return {
          ok: true,
          provider: profile.id,
          email: options.auth.user,
          host: profile.host,
          mailbox: 'INBOX',
        };
      } catch (error) {
        return {
          ok: false,
          provider: profile.id,
          email: options.auth.user,
          code: error?.code || 'IMAP_CONNECTION_FAILED',
          message: error instanceof Error ? error.message : 'IMAP connection failed',
        };
      } finally {
        if (typeof client.logout === 'function') {
          try { await client.logout(); } catch { /* connection already closed */ }
        }
      }
    },

    saveCredentials({ provider, email, authorizationCode }) {
      const normalizedProvider = requiredText(provider, 'provider');
      const normalizedEmail = requiredText(email, 'email');
      const credentialRef = credentialStore.save(requiredText(authorizationCode, 'authorizationCode'));
      return { provider: normalizedProvider, email: normalizedEmail, credentialRef };
    },
  };
}
