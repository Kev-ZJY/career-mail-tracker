import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { createDatabase, createMessageRepository } from './db.js';
import { createApi } from './api.js';
import { createCredentialStore } from './services/credential-store.js';
import { createSettingsService } from './services/settings-service.js';
import { createSyncService } from './services/sync-service.js';
import { createMailboxService } from './services/mailbox-service.js';
import { createImapSource } from './services/imap-source.js';
import { createLlmClassifier } from './services/llm-service.js';
import { bootstrapCredentials } from './services/credential-bootstrap.js';

const publicDirectory = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(request, response) {
  const rawPath = request.url.split('?')[0] === '/' ? '/index.html' : request.url;
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath.split('?')[0]);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  const filePath = resolve(join(publicDirectory, `.${pathname}`));
  if (!filePath.startsWith(`${publicDirectory}/`) || pathname.includes('..')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const body = await readFile(filePath);
    const extension = filePath.slice(filePath.lastIndexOf('.'));
    response.writeHead(200, {
      'content-type': contentTypes[extension] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

export function createServer({ config = createConfig(), databasePath } = {}) {
  const database = createDatabase(databasePath || resolve(config.dataDir, 'tracker.sqlite'));
  const repository = createMessageRepository(database.db);
  const credentialStore = createCredentialStore();
  const settingsService = createSettingsService({ repository, credentialStore });
  const mailboxService = createMailboxService({ credentialStore });
  const imapSource = createImapSource();
  const syncService = createSyncService({
    repository,
    analysisVersion: config.analysisVersion,
  });
  const api = createApi({
    config,
    repository,
    credentialStore,
    settingsService,
    syncService,
    imapSource,
    mailboxService,
    createClassifier: () => {
      const model = settingsService.getActiveModel();
      if (!model.credentialRef && model.id !== 'ollama') return null;
      return createLlmClassifier({
        provider: model,
        credentialStore,
      });
    },
  });
  const server = createHttpServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      void api(request, response);
      return;
    }
    void serveStatic(request, response);
  });

  return {
    server,
    database,
    async start() {
      await bootstrapCredentials({
        repository,
        credentialStore,
        secretsDir: resolve(config.dataDir, '.secrets'),
      });
      await new Promise((resolveStart, rejectStart) => {
        server.once('error', rejectStart);
        server.listen(config.port, config.host, resolveStart);
      });
      return server.address();
    },
    async close() {
      database.close();
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

export async function startServer(options = {}) {
  const app = createServer(options);
  const address = await app.start();
  const host = typeof address === 'object' && address?.address ? address.address : '127.0.0.1';
  const port = typeof address === 'object' && address?.port ? address.port : options.config?.port || 4317;
  return { ...app, url: `http://${host}:${port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = createConfig();
  startServer({ config }).then(() => {
    console.log(`Career Mail Tracker listening on http://${config.host}:${config.port}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
