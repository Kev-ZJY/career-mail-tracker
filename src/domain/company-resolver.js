const ORGANIZATION_SUFFIX_RE = /(?:集团有限公司|股份有限公司|有限责任公司|有限公司|集团|公司|incorporated|corporation|limited|inc|corp|ltd|llc|plc)$/iu;

function cleanCompany(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function comparisonKey(value) {
  let key = cleanCompany(value)
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  let previous = '';
  while (key && previous !== key) {
    previous = key;
    key = key.replace(ORGANIZATION_SUFFIX_RE, '');
  }
  return key;
}

function uniqueMatch(values, targetKey) {
  if (!targetKey) return '';
  const matches = [...new Set(values.filter(Boolean))]
    .filter((value) => comparisonKey(value) === targetKey);
  return matches.length === 1 ? matches[0] : '';
}

export function resolveCompanyName({ company, threadRef, openThreads = [], aliases = {} } = {}) {
  const cleaned = cleanCompany(company);
  const aliasEntries = Object.entries(aliases || {});
  const aliasKey = comparisonKey(cleaned);
  const aliasMatches = aliasEntries.filter(([name]) => comparisonKey(name) === aliasKey);
  if (aliasMatches.length === 1) return cleanCompany(aliasMatches[0][1]);

  const existing = openThreads.map((thread) => cleanCompany(thread?.company)).filter(Boolean);
  const existingMatch = uniqueMatch(existing, aliasKey);
  if (existingMatch) return existingMatch;

  // threadRef is a routing suggestion, not evidence that can rewrite a company
  // explicitly extracted from this email. It is only safe as a last resort when
  // the identity stage could not find any company at all.
  if (cleaned) return cleaned;
  const referenced = Number.isInteger(threadRef)
    ? openThreads.find((thread) => thread?.id === threadRef)
    : null;
  return referenced?.company ? cleanCompany(referenced.company) : '';
}

export { comparisonKey as companyComparisonKey };
