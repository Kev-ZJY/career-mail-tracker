export function senderIdentityKey(value) {
  const source = String(value || '').toLocaleLowerCase('und');
  const match = source.match(/<?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9.-]+)>?/i);
  if (!match) return '';
  const organizationToken = match[1]
    .replace(/(?:no[._-]?reply|recruit(?:ment|ing)?|careers?|campus|talent|notification|support|admin|jobs?|hr|oa)/g, '')
    .replace(/[^a-z0-9]+/g, '');
  if (organizationToken.length >= 3) return `${match[1]}@${match[2]}`;
  // A two-label domain is normally organization-owned rather than a shared ATS
  // subdomain. Keep the full address so different generic mailboxes never merge.
  if (match[2].split('.').length === 2) return `${match[1]}@${match[2]}`;
  return '';
}

export function sameSenderIdentity(left, right) {
  const leftKey = senderIdentityKey(left);
  return Boolean(leftKey) && leftKey === senderIdentityKey(right);
}
