import { readFile } from 'node:fs/promises';

const EMPTY_RULES = Object.freeze({ companyAliases: Object.freeze({}) });

function decodeQuotedString(token, filePath, lineNumber) {
  try {
    return JSON.parse(token);
  } catch {
    throw new Error(`invalid quoted string in rules file ${filePath}:${lineNumber}`);
  }
}

export async function loadLocalRules(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { companyAliases: {} };
    throw error;
  }

  const companyAliases = {};
  let section = '';
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (section !== 'company_aliases') {
        throw new Error(`unsupported rules section "${section}" in ${filePath}:${lineNumber}`);
      }
      continue;
    }
    if (section !== 'company_aliases') {
      throw new Error(`company alias must be inside [company_aliases] in ${filePath}:${lineNumber}`);
    }
    const pair = line.match(/^("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
    if (!pair) throw new Error(`invalid company alias in ${filePath}:${lineNumber}`);
    const alias = decodeQuotedString(pair[1], filePath, lineNumber).trim();
    const canonical = decodeQuotedString(pair[2], filePath, lineNumber).trim();
    if (!alias || !canonical) throw new Error(`company alias cannot be empty in ${filePath}:${lineNumber}`);
    companyAliases[alias] = canonical;
  }

  return Object.keys(companyAliases).length ? { companyAliases } : { ...EMPTY_RULES, companyAliases: {} };
}
