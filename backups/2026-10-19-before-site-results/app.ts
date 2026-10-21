import { computerRoutes } from './computer-routes.js';
import { browserRoutes } from './browser-routes.js';
import { teamBoardRoutes } from './team-board-routes.js';
import {
  confirmationSchema,
  readConfirmationPolicy,
  writeConfirmationPolicy,
} from './confirmation-policy.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { configured, type Config } from './research.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
const interval = z.number().int().min(60).max(31_536_000).nullable();
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function matchesOrigin(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  try {
    const source = new URL(actual);
    const target = new URL(expected);
    return (
      actual === source.origin &&
      loopbackHosts.has(source.hostname) &&
      loopbackHosts.has(target.hostname) &&
      source.protocol === target.protocol &&
      source.port === target.port
    );
  } catch {
    return false;
  }
}
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  ownerToken?: string;
  origin?: string;
  platform?: Platform;
}
export function createApp({
  store,
  runner,
  config,
  ownerToken,
  origin,
  platform,
}: AppOptions) {
  const app = new Hono();
  const smallBodies = bodyLimit({
    maxSize: 1_000_000,
    onError: (c) => c.json({ error: 'Request is too large.' }, 413),
  });
  // Chat attachments (base64) may be up to ~20 MB.
  const uploadBodies = bodyLimit({
    maxSize: 28_500_000,
    onError: (c) => c.json({ error: 'Attachment is too large.' }, 413),
  });
  // A chat sends its whole conversation with each message; a night of trading
  // (400 tool results) passed 1 MB and every new message got a 413. The model
  // still sees only the recent part (fitHistory).
  const chatBodies = bodyLimit({
    maxSize: 50_000_000,
    onError: (c) =>
      c.json(
        {
          error: 'This conversation is too long to continue; start a new chat.',
        },
        413,
      ),
  });
  app.use('/api/*', (c, next) =>
    c.req.path === '/api/uploads'
      ? uploadBodies(c, next)
      : c.req.path.startsWith('/api/copilotkit')
        ? chatBodies(c, next)
        : smallBodies(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const requestUrl = new URL(c.req.url);
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(origin ? [new URL(origin).hostname] : []),
    ]);
    if (!ownerToken && !allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const expectedOrigin = origin ?? new URL(c.req.url).origin;
    if (requestOrigin && !matchesOrigin(requestOrigin, expectedOrigin))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    if (ownerToken) {
      const expected = Buffer.from(ownerToken);
      const supplied = Buffer.from(
        c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
      );
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        return c.json(
          { error: 'Enter your owner access token to unlock OpenDots.' },
          401,
        );
    }
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });
  if (platform) app.route('/api', computerRoutes(platform.computers));
  if (platform) app.route('/api', browserRoutes(platform.browser));
  if (platform) app.route('/api', teamBoardRoutes(platform.teamBoard));
  // Send the owner's message to a running unattended task without stopping it;
  // the task reads it after the tool step in progress.
  app.post('/api/threads/:id/steer', async (c) => {
    if (!platform)
      return c.json({ error: 'Steering needs the local platform.' }, 503);
    // The current run loop does not read messages sent mid-run; say so rather
    // than accept a message that would never reach the task.
    if (!platform.config.steering)
      return c.json(
        {
          error:
            'Sending a message to a running task is not available in this version. Press Stop, then send it as a new message.',
        },
        409,
      );
    const threadId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    if (typeof body?.text !== 'string')
      return c.json({ error: 'Enter a message for the running task.' }, 400);
    const policy = platform.config.mcp?.localConfirmationConfig();
    if (
      !policy ||
      readConfirmationPolicy(policy.path, policy.defaultConfirm).mode !==
        'unattended'
    )
      return c.json(
        {
          error:
            'Messages reach a running task only in unattended mode. Send this after the current reply finishes.',
        },
        409,
      );
    if (!(await platform.runner.isRunning({ threadId })))
      return c.json(
        {
          error:
            'Nothing is running in this conversation; send it as a normal message.',
        },
        409,
      );
    try {
      return c.json(
        { waiting: platform.steering.push(threadId, body.text) },
        202,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  app.get('/api/confirmation-policy', (c) => {
    const config = platform?.config.mcp?.localConfirmationConfig();
    if (!config)
      return c.json(
        {
          error:
            'Live confirmation controls require the bundled local PC tools server.',
        },
        503,
      );
    return c.json(readConfirmationPolicy(config.path, config.defaultConfirm));
  });
  app.put('/api/confirmation-policy', async (c) => {
    const config = platform?.config.mcp?.localConfirmationConfig();
    if (!config)
      return c.json(
        {
          error:
            'Live confirmation controls require the bundled local PC tools server.',
        },
        503,
      );
    const parsed = confirmationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: 'Choose confirm or unattended mode.' }, 400);
    return c.json(writeConfirmationPolicy(config.path, parsed.data));
  });
  const voice = platform ? new VoiceService(platform) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));
  app.get('/api/state', (c) =>
    c.json({
      settings: store.settings(),
      tasks: store.tasks(),
      memories: store.memories(),
      mode: config.mode,
      configured: configured(config),
    }),
  );
  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        threadId: z.string().optional(),
        trigger: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('interval') }),
            z.object({
              type: z.literal('daily'),
              time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              days: z.array(z.number().int().min(0).max(6)).max(7),
            }),
            z.object({
              type: z.literal('file'),
              folder: z.string().min(3).max(500),
              pattern: z.string().min(1).max(100),
            }),
          ])
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (!store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        platform.workspace.requireThread(parsed.data.threadId);
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const trigger = parsed.data.trigger;
    if (trigger?.type === 'file' && !existsSync(trigger.folder))
      return c.json({ error: 'That folder does not exist.' }, 400);
    const task = store.createTask(
      parsed.data.prompt,
      trigger && trigger.type !== 'interval'
        ? null
        : parsed.data.intervalSeconds,
      trigger && trigger.type !== 'interval' ? JSON.stringify(trigger) : null,
    );
    if (platform && parsed.data.threadId)
      platform.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const detail = store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    if (parsed.data.action === 'run' && !store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    const task = store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({ intervalSeconds: interval })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    const task = store.schedule(c.req.param('id'), parsed.data.intervalSeconds);
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        researchAllowed: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = store.settings();
    const settings = store.updateSettings(parsed.data);
    if (
      settings.paused ||
      !settings.researchAllowed ||
      previous.memoryAllowed !== settings.memoryAllowed
    )
      runner.abortAll();
    if (settings.paused) voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  app.post('/api/memories', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    return c.json(store.saveMemory(parsed.data.text), 201);
  });
  app.put('/api/memories/:id', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    if (!store.memories().some((m) => m.id === c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(store.saveMemory(parsed.data.text, c.req.param('id')));
  });
  app.delete('/api/memories/:id', (c) =>
    store.deleteMemory(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  app.onError((error, c) => {
    console.error('API request failed:', error.name);
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
