const defaultProviders = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3.5-lightning:free',
    credentialRequired: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    credentialRequired: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    credentialRequired: true,
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    credentialRequired: false,
  },
];

function cleanText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function serializeProvider(profile, credentialStore) {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    credentialConfigured: profile.credentialRequired === false
      || credentialStore.has(profile.credentialRef),
  };
}

function serializeMailbox(profile, credentialStore) {
  if (!profile) return null;
  return {
    provider: profile.provider,
    email: profile.email,
    credentialConfigured: credentialStore.has(profile.credentialRef),
  };
}

export function createSettingsService({ repository, credentialStore }) {
  return {
    getSettings() {
      const savedProviders = repository.getSetting('model.providers', {});
      const providers = defaultProviders.map((provider) => serializeProvider({
        ...provider,
        ...(savedProviders[provider.id] || {}),
      }, credentialStore));
      for (const [id, provider] of Object.entries(savedProviders)) {
        if (!providers.some((item) => item.id === id)) {
          providers.push(serializeProvider(provider, credentialStore));
        }
      }
      return {
        providers,
        mailbox: serializeMailbox(repository.getSetting('mailbox.account'), credentialStore),
      };
    },

    saveProvider(input) {
      const id = cleanText(input.id, 'id');
      const name = cleanText(input.name, 'name');
      const baseUrl = cleanText(input.baseUrl, 'baseUrl');
      const model = cleanText(input.model, 'model');
      const protocol = input.protocol === 'custom' ? 'custom' : 'openai-compatible';
      const savedProviders = repository.getSetting('model.providers', {});
      const previous = savedProviders[id] || defaultProviders.find((provider) => provider.id === id);
      const credentialRef = input.apiKey
        ? credentialStore.save(input.apiKey)
        : previous?.credentialRef || null;
      const profile = {
        id,
        name,
        protocol,
        baseUrl,
        model,
        credentialRequired: previous?.credentialRequired !== false && id !== 'ollama',
        credentialRef,
      };
      repository.saveSetting('model.providers', { ...savedProviders, [id]: profile });
      repository.saveSetting('model.activeId', id);
      return serializeProvider(profile, credentialStore);
    },

    saveMailbox(input) {
      const provider = cleanText(input.provider, 'provider');
      if (!['qq', 'netease'].includes(provider)) {
        throw new Error('provider must be qq or netease');
      }
      const email = cleanText(input.email, 'email');
      const previous = repository.getSetting('mailbox.account');
      const credentialRef = input.authorizationCode
        ? credentialStore.save(input.authorizationCode)
        : previous?.credentialRef || null;
      const profile = { provider, email, credentialRef };
      repository.saveSetting('mailbox.account', profile);
      return serializeMailbox(profile, credentialStore);
    },

    getMailboxConnection() {
      const profile = repository.getSetting('mailbox.account');
      if (!profile) return null;
      return {
        ...profile,
        authorizationCode: credentialStore.get(profile.credentialRef),
      };
    },

    getActiveModel() {
      const savedProviders = repository.getSetting('model.providers', {});
      const activeId = repository.getSetting('model.activeId', 'openrouter');
      const base = defaultProviders.find((provider) => provider.id === activeId) || defaultProviders[0];
      const profile = { ...base, ...(savedProviders[activeId] || {}) };
      return { ...profile, apiKey: credentialStore.get(profile.credentialRef) };
    },
  };
}
