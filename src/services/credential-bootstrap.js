import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SECRET_FILES = [
  { file: 'openrouter-api-key.txt', setting: 'model.providers', profileId: 'openrouter', field: 'credentialRef' },
  { file: 'deepseek-api-key.txt', setting: 'model.providers', profileId: 'deepseek', field: 'credentialRef' },
  { file: 'mailbox-netease-auth.txt', setting: 'mailbox.account', profileId: null, field: 'credentialRef' },
  { file: 'mailbox-qq-auth.txt', setting: 'mailbox.account', profileId: null, field: 'credentialRef' },
];

export async function bootstrapCredentials({ repository, credentialStore, secretsDir }) {
  let mailboxEmail = null;
  try {
    mailboxEmail = (await readFile(join(secretsDir, 'mailbox-email.txt'), 'utf8')).trim() || null;
  } catch {
    mailboxEmail = null;
  }

  for (const entry of SECRET_FILES) {
    let secret;
    try {
      secret = (await readFile(join(secretsDir, entry.file), 'utf8')).trim();
    } catch {
      continue;
    }
    if (!secret) continue;
    const container = repository.getSetting(entry.setting, {});
    const profile = entry.profileId ? container[entry.profileId] : container;
    const existingRef = profile?.[entry.field];
    if (existingRef && credentialStore.get(existingRef) === secret) continue;
    const ref = credentialStore.save(secret);
    if (!ref) continue;
    if (entry.profileId) {
      repository.saveSetting(entry.setting, {
        ...container,
        [entry.profileId]: { ...profile, [entry.field]: ref },
      });
    } else {
      repository.saveSetting(entry.setting, { ...profile, [entry.field]: ref });
    }
  }

  if (mailboxEmail) {
    const profile = repository.getSetting('mailbox.account');
    if (!profile || profile.email !== mailboxEmail) {
      repository.saveSetting('mailbox.account', { ...(profile || { provider: 'netease' }), email: mailboxEmail });
    }
  }

  // 首次默认：仅当用户从未设置过 activeId 时才写默认值（openrouter 优先，其次 deepseek）。
  // 已有设置时绝不覆盖——用户在「设置」里的手动选择必须优先于启动逻辑。
  const activeId = repository.getSetting('model.activeId', null);
  if (activeId == null) {
    const savedProviders = repository.getSetting('model.providers', {});
    const openrouterProfile = savedProviders?.openrouter;
    const deepseekProfile = savedProviders?.deepseek;
    const openrouterConfigured = Boolean(openrouterProfile?.credentialRef && credentialStore.get(openrouterProfile.credentialRef));
    const deepseekConfigured = Boolean(deepseekProfile?.credentialRef && credentialStore.get(deepseekProfile.credentialRef));
    if (openrouterConfigured) {
      repository.saveSetting('model.activeId', 'openrouter');
    } else if (deepseekConfigured) {
      repository.saveSetting('model.activeId', 'deepseek');
    }
  }
}
