import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { platformConfigFromEnv } from './platform-config.js';
import { parseServerEnv } from '../config/env.js';

const env = parseServerEnv();
const host = env.HOST;
const port = env.PORT;
const store = new Store(env.DATABASE_PATH);
const workspace = new WorkspaceStore(env.DATABASE_PATH, env.OWNER_ID);
const runtimeUrl = `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`;
const config = platformConfigFromEnv(env, {
  runtimeUrl,
  ownerToken: env.OWNER_TOKEN,
});
const platform = new Platform(store, workspace, config);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its Intelligence conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal);
    return { text, sources: [], sample: false };
  },
);
const wsOrigin = new URL(
  config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
).origin;
const origin =
  env.APP_ORIGIN ??
  (env.NODE_ENV === 'development' ? 'http://127.0.0.1:5173' : undefined);
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken: config.ownerToken,
  origin,
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);