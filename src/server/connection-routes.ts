import { Hono } from 'hono';
import { z } from 'zod';
import { connectionActionSchema } from '../shared/connection-types.js';
import type { WorkspaceStore } from './workspace.js';
import { connectionInput, type ConnectionService } from './connections.js';
export function connectionRoutes(
  workspace: WorkspaceStore,
  connections: ConnectionService,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid connection request.')
            : error.message,
      },
      400,
    ),
  );
  const requireDot = (id: string) => {
    if (!workspace.dot(id)) throw new Error('Dot not found.');
    return id;
  };
  const owned = (id: string) => {
    const connection = connections.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    return connection;
  };
  app.get('/dots/:id/connections', (c) =>
    c.json(connections.store.list(requireDot(c.req.param('id')))),
  );
  app.post('/dots/:id/connections', async (c) =>
    c.json(
      await connections.add(
        requireDot(c.req.param('id')),
        connectionInput.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/connections/:id/refresh', async (c) =>
    c.json(await connections.refresh(owned(c.req.param('id')).id)),
  );
  app.patch('/connections/:id/tools/:name', async (c) => {
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      connections.setTool(
        owned(c.req.param('id')).id,
        c.req.param('name'),
        patch,
      ),
    );
  });
  app.delete('/connections/:id', (c) => {
    connections.store.remove(owned(c.req.param('id')).id);
    return c.json({ ok: true });
  });
  app.get('/conversations/:id/connection-tools/:name', (c) => {
    const thread = workspace.requireThread(c.req.param('id'));
    const { connection, tool } = connections.resolve(
      thread.dotId,
      c.req.param('name'),
    );
    return c.json({
      connection: connection.name,
      title: tool.title,
      description: tool.description,
    });
  });
  app.get('/conversations/:id/connection-actions/:toolCallId', (c) => {
    const thread = workspace.requireThread(c.req.param('id'));
    return c.json(
      connections.store.action(thread.id, c.req.param('toolCallId')) ?? null,
    );
  });
  // The only path that runs an approval-gated tool: an owner request for a
  // tool this conversation's Dot currently has enabled.
  app.post('/conversations/:id/connection-actions', async (c) => {
    const body = connectionActionSchema
      .omit({ summary: true })
      .extend({ toolCallId: z.string().min(1).max(200) })
      .parse(await c.req.json());
    const thread = workspace.requireThread(c.req.param('id'));
    const exposed = connections.resolve(thread.dotId, body.tool);
    if (
      !connections.store.claimAction(
        thread.id,
        body.toolCallId,
        exposed.connection.id,
        exposed.tool.name,
      )
    ) {
      const previous = connections.store.action(thread.id, body.toolCallId);
      if (previous?.result) return c.json(previous.result);
      return c.json({ error: 'This action is already running.' }, 409);
    }
    // Not tied to the request: once approved, finish even if the tab closes.
    const result = await connections.call(exposed, body.arguments);
    connections.store.finishAction(thread.id, body.toolCallId, result);
    return c.json(result);
  });
  return app;
}
