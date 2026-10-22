import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import type { PlatformConfig } from './platform-config.js';
import { McpTools, loadMcpServers } from './mcp-tools.js';
import { FileTriggers } from './file-triggers.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
const config: PlatformConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1',
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
  mcp: new McpTools(loadMcpServers(process.env.MCP_SERVERS_PATH)),
  runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS) || undefined,
  maxAgentIterations: Number(process.env.MAX_AGENT_ITERATIONS) || undefined,
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) || undefined,
  contextTokens: Number(process.env.OLLAMA_CONTEXT_LENGTH) || 16384,
  reservedTokens: Number(process.env.RESERVED_TOKENS) || undefined,
};
const platform = new Platform(store, workspace, config, database);
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
        'This legacy task has no conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its local conversation.');
    const prompt = claim.pendingInput
      ? `${claim.prompt}

This run was triggered by:
${claim.pendingInput}`
      : claim.prompt;
    const text = await platform.turn(threadId, prompt, signal);
    return { text, sources: [], sample: false };
  },
  config.runTimeoutMs ?? 600_000,
);
const fileTriggers = new FileTriggers(store);
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin:
    process.env.APP_ORIGIN ??
    (process.env.NODE_ENV === 'development'
      ? 'http://127.0.0.1:5173'
      : undefined),
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  fileTriggers.start();
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
  stopRunner: () => {
    fileTriggers.stop();
    runner.stop();
  },
  stopPlatform: async () => {
    await platform.stop();
    await config.mcp?.close();
  },
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
