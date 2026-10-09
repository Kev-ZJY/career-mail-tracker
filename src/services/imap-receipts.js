// A UID is immutable only within one mailbox's UIDVALIDITY epoch. Never infer
// that a newly discovered UID is complete from its Message-ID or received date.
// Bump this token when source parsing or prescreen semantics change without an
// analysis-version bump, so ignored/out-of-window mail can be reconsidered.
const RECEIPT_VERSION = 'imap-completion-v1';

export function imapReceiptScope({ accountId, provider, email, mailboxEmail, folder = 'INBOX', uidValidity, analysisVersion }) {
  const validity = String(uidValidity ?? '');
  const address = String(mailboxEmail || email || '').trim().toLowerCase();
  if (!accountId || !provider || !address || !analysisVersion || !/^[1-9]\d*$/.test(validity)) return null;
  return {
    accountId,
    provider,
    mailboxEmail: address,
    folder,
    uidValidity: validity,
    analysisVersion,
    completionVersion: `${RECEIPT_VERSION}|${analysisVersion}`,
  };
}

export function imapReceiptIdentity({ accountId, mailboxEmail, analysisVersion, message }) {
  const scope = imapReceiptScope({
    accountId,
    provider: message.provider,
    mailboxEmail: message.mailboxEmail || mailboxEmail,
    folder: message.folder,
    uidValidity: message.uidValidity,
    analysisVersion,
  });
  const uid = String(message.uid ?? '');
  return scope && /^[1-9]\d*$/.test(uid) ? { ...scope, uid } : null;
}
