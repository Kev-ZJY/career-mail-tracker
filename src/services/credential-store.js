export function createCredentialStore() {
  const secrets = new Map();
  let sequence = 0;

  return {
    save(secret) {
      if (typeof secret !== 'string' || secret.trim() === '') return null;
      const ref = `memory-credential-${++sequence}`;
      secrets.set(ref, secret);
      return ref;
    },

    has(ref) {
      return typeof ref === 'string' && secrets.has(ref);
    },

    get(ref) {
      return typeof ref === 'string' ? secrets.get(ref) || null : null;
    },

    delete(ref) {
      if (typeof ref !== 'string') return false;
      return secrets.delete(ref);
    },
  };
}
