import { serve, type HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright';
import { z } from 'zod';
import { validateUrl } from './security.js';
import { readResource } from './transport.js';
import { parseBrowserEnv } from '../config/env.js';

const browserEnv = parseBrowserEnv();
const secret = browserEnv.BROWSER_SECRET;
const app = new Hono<{ Bindings: HttpBindings }>();
app.use('*', bodyLimit({ maxSize: 16_384 }));
app.use('*', async (c, next) => {
  const supplied = Buffer.from(
    c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
  );
  const expected = Buffer.from(secret);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
let busy = false;
app.post('/browse', async (c) => {
  const parsed = z
    .object({ url: z.string().url().max(2048) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: 'A valid URL is required.' }, 400);
  if (busy) return c.json({ error: 'Browser is busy. Retry shortly.' }, 429);
  busy = true;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(new Error('Browser request cancelled.'));
    void browser?.close();
  };
  const disconnected = () => {
    if (!c.env.outgoing.writableFinished) abort();
  };
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  c.env.outgoing.on('close', disconnected);
  const deadline = setTimeout(abort, 40_000);
  let mainError: string | undefined;
  try {
    await validateUrl(parsed.data.url);
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });
    controller.signal.throwIfAborted();
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: { width: 1200, height: 800 },
    });
    let count = 0;
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        ++count > 50 ||
        request.method() !== 'GET' ||
        !['document', 'stylesheet', 'image', 'font'].includes(
          request.resourceType(),
        )
      ) {
        await route.abort();
        return;
      }
      try {
        await route.fulfill(
          await readResource(request.url(), controller.signal),
        );
      } catch (error) {
        if (request.isNavigationRequest())
          mainError =
            error instanceof Error ? error.message : 'Navigation failed.';
        await route.abort();
      }
    });
    const page = await context.newPage();
    const response = await page.goto(parsed.data.url, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });
    if (mainError) throw new Error(mainError);
    if (!response || response.status() >= 400)
      throw new Error(
        `Source returned HTTP ${response?.status() ?? 'unknown'}.`,
      );
    await validateUrl(page.url());
    const text = (
      await page.locator('body').innerText({ timeout: 5000 })
    ).slice(0, 30_000);
    const title = await page.title();
    const screenshot = (
      await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })
    ).toString('base64');
    return c.json({
      url: page.url(),
      title,
      text,
      screenshot: `data:image/jpeg;base64,${screenshot}`,
    });
  } catch (error) {
    return c.json(
      {
        error:
          mainError ??
          (error instanceof Error ? error.message : 'Browser failed.'),
      },
      502,
    );
  } finally {
    clearTimeout(deadline);
    c.req.raw.signal.removeEventListener('abort', abort);
    c.env.outgoing.off('close', disconnected);
    try {
      await browser?.close();
    } finally {
      busy = false;
    }
  }
});
app.get('/health', (c) => c.json({ ok: true }));
serve({
  fetch: app.fetch,
  hostname: browserEnv.BROWSER_HOST,
  port: browserEnv.BROWSER_PORT,
});
