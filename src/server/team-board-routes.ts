import { Hono } from 'hono';
import { boardInput, type TeamBoardService } from './team-board.js';

export function teamBoardRoutes(service: TeamBoardService) {
  const app = new Hono();
  app.get('/team-board', (c) =>
    c.json({ boards: service.store.list().slice(0, 50) }),
  );
  app.get('/team-board/:id', (c) => {
    try {
      return c.json(service.store.get(c.req.param('id')));
    } catch {
      return c.json({ error: 'Team board not found.' }, 404);
    }
  });
  app.post('/team-board', async (c) => {
    const parsed = boardInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Provide an objective, 2–8 participant IDs, a decision maker and 1–5 rounds.',
        },
        400,
      );
    try {
      return c.json(service.create(parsed.data), 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  app.post('/team-board/:id/stop', (c) => {
    try {
      return c.json(service.stop(c.req.param('id')));
    } catch {
      return c.json({ error: 'Team board not found.' }, 404);
    }
  });
  app.post('/team-board/:id/steps/:stepId/report', async (c) => {
    try {
      return c.json(
        service.resubmitReport(
          c.req.param('id'),
          c.req.param('stepId'),
          await c.req.json(),
        ),
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  app.post('/team-board/:id/guidance', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      guidance?: unknown;
    } | null;
    if (typeof body?.guidance !== 'string')
      return c.json({ error: 'Enter execution guidance.' }, 400);
    try {
      return c.json(service.steer(c.req.param('id'), body.guidance));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  return app;
}
