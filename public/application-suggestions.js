const UNKNOWN_NAMES = new Set([
  '', '-', '—', '未知', '不详', '无', '未识别', '未识别公司', '未识别岗位', '未识别职位',
  '未知公司', '未知岗位', '未知职位', '待确认', '待识别', 'unknown', 'n/a', 'null',
]);

function nameValue(value) { return typeof value === 'string' ? value.trim() : ''; }
function nameKey(value) { return nameValue(value).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase(); }
function knownName(value) { return !UNKNOWN_NAMES.has(nameKey(value)); }

// Source application names remain useful after a displayed application is merged.
function applicationNames(rows) {
  return (rows || []).flatMap((row) => [row, ...(row.sourceApplications || []), ...(row.originalApplications || [])]);
}

function queryRank(value, query) {
  const key = nameKey(value);
  return key === query ? 0 : key.startsWith(query) ? 1 : 2;
}

export function getCompanySuggestions(rows, query = '') {
  const names = new Map();
  for (const row of applicationNames(rows)) {
    const value = nameValue(row.company);
    if (knownName(value) && !names.has(nameKey(value))) names.set(nameKey(value), { value });
  }
  const search = nameKey(query);
  return [...names.values()].filter(({ value }) => nameKey(value).includes(search))
    .sort((a, b) => queryRank(a.value, search) - queryRank(b.value, search));
}

export function getPositionSuggestions(rows, { company = '', query = '' } = {}) {
  const names = new Map();
  const companyKey = knownName(company) ? nameKey(company) : '';
  for (const row of applicationNames(rows)) {
    const value = nameValue(row.position);
    if (!knownName(value)) continue;
    const key = nameKey(value);
    if (!names.has(key)) names.set(key, { value, companies: [], matchesCompany: false });
    const candidate = names.get(key);
    const sourceCompany = nameValue(row.company);
    if (knownName(sourceCompany) && !candidate.companies.some((name) => nameKey(name) === nameKey(sourceCompany))) {
      candidate.companies.push(sourceCompany);
    }
    if (companyKey && nameKey(sourceCompany) === companyKey) candidate.matchesCompany = true;
  }
  const search = nameKey(query);
  return [...names.values()].filter(({ value }) => nameKey(value).includes(search))
    .sort((a, b) => Number(b.matchesCompany) - Number(a.matchesCompany) || queryRank(a.value, search) - queryRank(b.value, search));
}
