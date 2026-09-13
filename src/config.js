const DEFAULT_PORT = 4317;
// 每次改动提示词或默认模型都要 bump，否则存量邮件不会重新分析
const ANALYSIS_VERSION = 'generic-mail-extraction-v2';

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
  };
}
