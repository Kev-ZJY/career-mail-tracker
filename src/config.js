const DEFAULT_PORT = 4317;
// 每次改动提示词或默认模型都要 bump，否则存量邮件不会重新分析
const ANALYSIS_VERSION = 'phase-9-fallback-removal-v1';

export function createConfig(env = process.env) {
  const parsedPort = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  return {
    host: '127.0.0.1',
    port,
    dataDir: env.DATA_DIR || 'data',
    analysisVersion: ANALYSIS_VERSION,
  };
}
