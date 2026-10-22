import { pageRoutes } from './page-routes.js';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { defaultToolGroups } from '../shared/capabilities.js';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import {
  learningContainerIdSchema,
  validateLearningSettings,
} from '../shared/learning.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    learningContainerId: learningContainerIdSchema.optional(),
    skillDeliveryEnabled: z.boolean().optional(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
    model: z.string().trim().max(120).nullable().optional(),
    thinking: z.boolean().optional(),
    toolGroups: z
      .array(z.string().regex(/^(mcp:)?[a-z0-9_-]+$/i))
      .max(50)
      .optional(),
  })
  .strict();
const uploadTypes: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
};
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.get('/workspace', async (c) =>
    c.json({
      models: {
        ...platform.models.settings(),
        available: await platform.models.refresh(),
      },
      mcpGroups: (platform.config.mcp?.extraServers() ?? []).map(
        (name) => `mcp:${name}`,
      ),
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      conversations: platform.workspace.conversations(),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    try {
      validateLearningSettings(
        data.data.learningContainerId ?? null,
        data.data.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
        data.data.learningContainerId,
        data.data.skillDeliveryEnabled,
        data.data.model ?? null,
        data.data.toolGroups ?? defaultToolGroups,
        data.data.thinking ?? true,
      ),
      201,
    );
  });
  // Developer Dot: code changes wait here until the owner applies or rejects.
  app.get('/dev/reviews', (c) => c.json({ reviews: platform.dev.reviews() }));
  app.post('/dev/reviews/:id/:action', async (c) => {
    try {
      const id = c.req.param('id');
      const action = c.req.param('action');
      if (action === 'apply') return c.json(await platform.dev.apply(id));
      if (action === 'reject') return c.json(await platform.dev.reject(id));
      return c.json({ error: 'Unknown action.' }, 400);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed.' },
        409,
      );
    }
  });
  // Self-improvement: learned skills and owner-approved instruction proposals.
  app.get('/dots/:id/skills', (c) => {
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({
      skills: platform.skills.list(dot.id),
      proposal: platform.skills.pending(dot.id) ?? null,
    });
  });
  app.delete('/skills/:id', (c) =>
    platform.skills.delete(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Skill not found.' }, 404),
  );
  app.post('/proposals/:id/:action', (c) => {
    const action = c.req.param('action');
    const proposal = platform.skills.proposal(c.req.param('id'));
    if (!proposal || proposal.status !== 'pending')
      return c.json({ error: 'No pending proposal.' }, 404);
    if (action === 'apply') {
      const dot = platform.workspace.dot(proposal.dotId);
      if (!dot) return c.json({ error: 'Dot not found.' }, 404);
      // Only the instructions change; tools, model and access stay as set.
      platform.workspace.updateDot(dot.id, {
        ...dot,
        instructions: proposal.instructions,
      });
      platform.skills.resolve(proposal.id, 'applied');
    } else if (action === 'dismiss')
      platform.skills.resolve(proposal.id, 'dismissed');
    else return c.json({ error: 'Unknown action.' }, 400);
    return c.json({ ok: true });
  });
  app.patch('/models', async (c) => {
    const data = z
      .object({
        defaultModel: z.string().trim().min(1).max(120).optional(),
        plannerModel: z.string().trim().min(1).max(120).optional(),
        visionModel: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success) return c.json({ error: 'Invalid model settings.' }, 400);
    return c.json(platform.models.update(data.data));
  });
  // Files attached in chat are saved locally so Dots can open them with tools.
  app.post('/uploads', async (c) => {
    const data = z
      .object({
        name: z.string().min(1).max(200),
        type: z.string().max(100),
        data: z.string().max(28_000_000),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Attach a file up to 20 MB.' }, 400);
    const extension = uploadTypes[data.data.type];
    if (!extension)
      return c.json(
        { error: 'Attach an image, text, CSV, JSON, Markdown or PDF file.' },
        415,
      );
    const folder = resolve(dirname(platform.databasePath), 'uploads');
    mkdirSync(folder, { recursive: true });
    const base = basename(data.data.name, extname(data.data.name))
      .replace(/[^a-z0-9._-]+/gi, '-')
      .slice(0, 60);
    const path = join(folder, `${Date.now()}-${base || 'file'}${extension}`);
    writeFileSync(path, Buffer.from(data.data.data, 'base64'));
    return c.json({ path, name: data.data.name, type: data.data.type }, 201);
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    try {
      validateLearningSettings(
        data.data.learningContainerId === undefined
          ? (current.learningContainerId ?? null)
          : data.data.learningContainerId,
        data.data.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.get('/conversations/running', async (c) =>
    c.json({ ids: await platform.runningConversations() }),
  );
  app.delete('/conversations/:id', async (c) => {
    try {
      await platform.deleteConversation(c.req.param('id'));
      return c.json({ deleted: true });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Could not delete it.',
        },
        404,
      );
    }
  });
  app.get('/conversations/:id/capture', (c) =>
    c.json(platform.workspace.capture(c.req.param('id'))),
  );
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', (c) =>
    c.json(voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.all('/copilotkit/*', (c) => platform.handle(c.req.raw));
  app.onError((error, c) => {
    const text = error.message;
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio|Intelligence could not)/.test(
        text,
      );
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
