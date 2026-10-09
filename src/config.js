import { resolveTimeouts } from './services/deadline.js';

const DEFAULT_PORT = 4317;
// Bump only when extraction semantics change; this triggers reanalysis of saved mail.
const ANALYSIS_VERSION = 'generic-mail-extraction-v7';

export function createConfig(env = process.env) {
  const parsedPort = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  const dataDir = env.DATA_DIR || 'data';
  return {
    host: '127.0.0.1',
    port,
    dataDir,
    rulesFile: env.RULES_FILE || `${dataDir}/rules.toml`,
    analysisVersion: ANALYSIS_VERSION,
    syncTimeouts: resolveTimeouts(env),
  };
}
