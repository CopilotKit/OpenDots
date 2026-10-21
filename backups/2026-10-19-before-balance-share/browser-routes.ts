import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { LiveBrowser } from './browser-live.js';

const inputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: z.number().min(0).max(20000),
    y: z.number().min(0).max(20000),
    button: z.enum(['left', 'right']).optional(),
  }),
  z.object({
    type: z.literal('wheel'),
    dx: z.number().min(-5000).max(5000),
    dy: z.number().min(-5000).max(5000),
  }),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
]);

export function browserRoutes(live: LiveBrowser) {
  const app = new Hono();
  const failure = (error: unknown) =>
    error instanceof Error ? error.message : 'Browser action failed.';
  app.get('/browser/status', async (c) => c.json(await live.status()));
  app.get('/browser/stream', (c) =>
    streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let sending = false;
      await live.stream((frame) => {
        // Drop frames while the previous one is still being written.
        if (sending) return;
        sending = true;
        void stream
          .writeSSE({ event: 'frame', data: JSON.stringify(frame) })
          .catch(() => controller.abort())
          .finally(() => (sending = false));
      }, controller.signal);
    }),
  );
  app.post('/browser/start', async (c) => {
    const body = z
      .object({ url: z.string().max(2048).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    try {
      await live.start(body.success ? body.data.url : undefined);
      return c.json(await live.status());
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/navigate', async (c) => {
    const body = z
      .union([
        z.object({ url: z.string().min(1).max(2048) }),
        z.object({ action: z.enum(['back', 'forward', 'reload']) }),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid navigation.' }, 400);
    try {
      if ('url' in body.data) await live.goto(body.data.url);
      else await live.navigate(body.data.action);
      return c.json(await live.status());
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/signin', async (c) => {
    const body = z
      .object({ url: z.string().min(1).max(2048) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Enter a sign-in URL.' }, 400);
    try {
      await live.signInWindow(body.data.url);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/takeover', async (c) => {
    const body = z
      .object({ on: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid takeover.' }, 400);
    live.setTakeover(body.data.on);
    return c.json(await live.status());
  });
  // Owner teaching from the browser panel: start, then the owner clicks the
  // control in the live view and confirms it in the page; finish saves it.
  app.post('/browser/teach', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(160),
        kind: z.enum(['button', 'region']).default('button'),
        // Let the owner's first clicks through, for buttons that appear only
        // after another click (e.g. Double Up after BUY).
        afterClicks: z.number().int().min(0).max(3).default(0),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'Name the button you want to teach.' }, 400);
    try {
      return c.json(
        await live.teachStart(
          body.data.name,
          body.data.kind,
          body.data.kind === 'button' ? body.data.afterClicks : 0,
        ),
      );
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.get('/browser/teach', async (c) => {
    try {
      return c.json(await live.teachStatus());
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.post('/browser/teach/finish', async (c) => {
    try {
      return c.json(await live.teachFinish());
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.post('/browser/teach/cancel', async (c) => {
    try {
      return c.json(await live.teachCancel());
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.get('/browser/targets', async (c) => {
    try {
      return c.json(await live.targets());
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/targets/:id/forget', async (c) => {
    try {
      return c.json(await live.forgetTarget(c.req.param('id')));
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  // Pairs dashboard under the live view: the latest scan, a new scan, a switch.
  app.get('/browser/pairs', (c) => c.json(live.pairScan()));
  app.post('/browser/pairs/scan', async (c) => {
    const body = z
      .object({
        count: z.number().int().min(2).max(20).optional(),
        market: z.enum(['otc', 'real', 'same']).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    try {
      return c.json(
        await live.scanPairs(
          body.success ? body.data.count : undefined,
          body.success ? body.data.market : undefined,
        ),
      );
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.get('/browser/trading-mode', (c) => c.json(live.tradingMode()));
  app.post('/browser/trading-mode', async (c) => {
    const body = z
      .object({ obviousOnly: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give obviousOnly.' }, 400);
    return c.json(live.setTradingMode(body.data.obviousOnly));
  });
  app.post('/browser/pairs/choose', async (c) => {
    const body = z
      .object({ name: z.string().min(1).max(60) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give a pair name.' }, 400);
    try {
      return c.json(await live.choosePair(body.data.name));
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  app.post('/browser/input', async (c) => {
    const body = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid input event.' }, 400);
    try {
      await live.input(body.data);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  return app;
}
