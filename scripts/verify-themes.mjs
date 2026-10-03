// Run after npm run build: node --import tsx scripts/verify-themes.mjs
// Uses the real built React app, Hono API, and isolated in-memory SQLite stores.
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AbstractAgent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, of, toArray } from 'rxjs';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace.ts';
import { Runner } from '../src/server/runner.ts';

// This fixture never needs the Intelligence cloud or a model provider.
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
const { Platform } = await import('../src/server/platform.ts');
const { createApp } = await import('../src/server/app.ts');
const { CopilotRuntime, InMemoryAgentRunner, createCopilotHonoHandler } =
  await import('@copilotkit/runtime/v2');

const ids = ['meadow', 'redwood', 'coastal', 'canyon', 'alpine'];
const output = 'artifacts/theme-verification';
await mkdir(output, { recursive: true });
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'theme-verification');
const config = { mode: 'sample', baseUrl: 'https://example.com' };
const space = workspace.spaces()[0];
workspace.updateDot(workspace.dots()[0].id, {
  ...workspace.dots()[0],
  name: 'Long Dot name for narrow phone navigation',
});
const document = workspace.pages.create(space.id, {
  title: 'A readable nature document',
  content:
    '# Garden notes\n\nA paragraph with **bold text**, a [link](https://example.com), and `inline code`.\n\n> A quiet quotation.\n\n- First item\n- Second item\n\n| Plant | Season |\n| --- | --- |\n| Fern | Spring |',
});
const dot = workspace.dots()[0];
const thread = workspace.bindThread(
  'theme-transcript-fixture',
  dot.id,
  'Theme transcript fixture',
);
const messages = [
  {
    id: 'theme-user-message',
    role: 'user',
    content:
      'User code:\n\n```js\nconst userValue = 42;\n```\n\nAn `inlineValue` and a [reference](https://example.com).\n\n- First item\n- Second item\n\n> User quotation.',
  },
  {
    id: 'theme-assistant-message',
    role: 'assistant',
    content:
      'Assistant code:\n\n```js\nconst assistantValue = 43;\n```\n\nAn `inlineValue` and a [reference](https://example.com).\n\n- First item\n- Second item\n\n> Assistant quotation.',
  },
];
class TranscriptFixtureAgent extends AbstractAgent {
  run(input) {
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      { type: EventType.MESSAGES_SNAPSHOT, messages },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    );
  }
}
const messageRunner = new InMemoryAgentRunner();
const fixtureAgent = new TranscriptFixtureAgent({ agentId: dot.id });
const seededEvents = await lastValueFrom(
  messageRunner
    .run({
      threadId: thread.id,
      agent: fixtureAgent,
      input: {
        threadId: thread.id,
        runId: 'theme-fixture-seed',
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
    })
    .pipe(toArray()),
);
assert(!seededEvents.some((event) => event.type === EventType.RUN_ERROR));
assert.deepEqual(messageRunner.getThreadMessages(thread.id), messages);
const platform = new Platform(store, workspace, {
  // Initialize without Intelligence so even construction stays offline; the
  // synthetic declared configuration below unlocks the actual configured UI.
  intelligenceKey: undefined,
  apiKey: 'theme-fixture-model-key',
  model: 'theme-fixture-model',
  baseUrl: 'http://127.0.0.1:1/model-must-not-be-called',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: '',
});
platform.config.intelligenceKey = 'theme-fixture-intelligence-key';
platform.handler = createCopilotHonoHandler({
  runtime: new CopilotRuntime({
    agents: { [dot.id]: fixtureAgent },
    runner: messageRunner,
  }),
  basePath: '/api/copilotkit',
  cors: { origin: [] },
});
assert.deepEqual(platform.setup().missing, []);
const app = createApp({
  store,
  runner: new Runner(store, config),
  config,
  platform,
});
app.use('*', async (context, next) => {
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  await next();
});
app.use('*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
let browser;
const receipt = [];
let screenshots = 0;
async function capture(page, name) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  screenshots++;
}

// Compute the painted ancestor background, including alpha compositing. Check
// actual text/value/placeholder colors, not only the palette declarations.
async function contrast(page, label) {
  const result = await page.evaluate(() => {
    const rgb = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (foreground, background) => {
      const alpha = foreground[3] ?? 1;
      return foreground
        .slice(0, 3)
        .map((value, index) => value * alpha + background[index] * (1 - alpha));
    };
    const luminance = (color) =>
      color
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (total, value, index) =>
            total + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    function background(element) {
      const layers = [];
      for (let cursor = element; cursor; cursor = cursor.parentElement)
        layers.unshift(rgb(getComputedStyle(cursor).backgroundColor));
      return layers.reduce(
        (base, layer) => blend(layer, base),
        [255, 255, 255],
      );
    }
    const failures = [];
    let checked = 0;
    for (const element of document.querySelectorAll('body *')) {
      if (
        !(element instanceof HTMLElement || element instanceof SVGSVGElement) ||
        element.closest('.call-view')
      )
        continue;
      const rect = element.getBoundingClientRect();
      if (
        !rect.width ||
        !rect.height ||
        rect.bottom < 0 ||
        rect.top > innerHeight
      )
        continue;
      let visible = true;
      let opacity = 1;
      for (let cursor = element; cursor; cursor = cursor.parentElement) {
        const style = getComputedStyle(cursor);
        if (
          style.visibility !== 'visible' ||
          Number(style.opacity) === 0 ||
          cursor.matches(':disabled,[hidden]')
        )
          visible = false;
        opacity *= Number(style.opacity);
      }
      if (!visible) continue;
      const direct = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim();
      const field = element.matches(
        'input:not([type=checkbox]),textarea,select',
      );
      const icon =
        element instanceof SVGSVGElement && !!element.closest('button');
      const toggleThumb = element.matches('.toggle > span');
      if (!direct && !field && !icon && !toggleThumb) continue;
      const style = getComputedStyle(element);
      const bg = background(toggleThumb ? element.parentElement : element);
      const check = (color, kind) => {
        const foreground = rgb(color);
        foreground[3] = (foreground[3] ?? 1) * opacity;
        const ink = blend(foreground, bg);
        const a = luminance(ink),
          b = luminance(bg);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.66 &&
            Number(style.fontWeight) >= 700);
        checked++;
        if (
          ratio + 0.01 <
          (icon || toggleThumb || kind === 'focus outline' || large ? 3 : 4.5)
        )
          failures.push({
            selector: element.tagName + '.' + element.className,
            text: direct.slice(0, 60),
            kind,
            ratio: Number(ratio.toFixed(2)),
            color,
            bg,
          });
      };
      check(
        toggleThumb ? style.backgroundColor : style.color,
        toggleThumb ? 'toggle thumb' : icon ? 'control icon' : 'text',
      );
      if (element.matches(':focus-visible') && parseFloat(style.outlineWidth))
        check(style.outlineColor, 'focus outline');
      if (field && element.getAttribute('placeholder'))
        check(getComputedStyle(element, '::placeholder').color, 'placeholder');
    }
    return { checked, failures };
  });
  receipt.push({ label, ...result });
}

async function headerFits(page) {
  const bounds = await page.locator('.topbar').evaluate((header) => {
    const rects = [...header.querySelectorAll('button,select')]
      .map((element) => ({
        label: element.getAttribute('aria-label'),
        ...element.getBoundingClientRect().toJSON(),
      }))
      .filter((rect) => rect.width);
    return {
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      rects,
    };
  });
  assert(
    bounds.scroll <= bounds.width,
    `Horizontal overflow: ${JSON.stringify(bounds)}`,
  );
  for (const rect of bounds.rects)
    assert(
      rect.left >= 0 && rect.right <= bounds.width,
      `Clipped control: ${JSON.stringify(rect)}`,
    );
}

async function transcript(page, label) {
  const userCode = page.locator('.chat-bubble.user pre');
  const assistantCode = page.locator('.chat-bubble.assistant pre');
  await userCode.waitFor();
  await assistantCode.waitFor();
  assert.equal((await userCode.textContent()).trim(), 'const userValue = 42;');
  assert.equal(
    (await assistantCode.textContent()).trim(),
    'const assistantValue = 43;',
  );
  for (const role of ['user', 'assistant']) {
    const bubble = page.locator(`.chat-bubble.${role}`);
    assert.equal(await bubble.locator('p code').textContent(), 'inlineValue');
    assert.equal(
      await bubble.getByRole('link').getAttribute('href'),
      'https://example.com',
    );
    assert.equal(await bubble.locator('li').count(), 2);
    assert(
      (await bubble.locator('blockquote').textContent()).includes('quotation.'),
    );
    await bubble.locator('blockquote').scrollIntoViewIfNeeded();
    await contrast(page, `${label}-${role}-rich-markdown`);
  }
  await userCode.scrollIntoViewIfNeeded();
  await contrast(page, `${label}-user-code`);
  await assistantCode.scrollIntoViewIfNeeded();
  await contrast(page, `${label}-assistant-code`);
}

async function focusDock(page, label) {
  const dock = page.locator('.document-chat-dock');
  const input = page.getByRole('textbox', { name: 'Ask about this page' });
  await dock.waitFor();
  await input.waitFor();
  await page.getByRole('textbox', { name: 'Page title' }).focus();
  const before = await dock.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  await input.focus();
  await input.fill('A readable, focused page prompt');
  const cue = await dock.evaluate((element) => {
    const input = element.querySelector('input');
    const dockStyle = getComputedStyle(element);
    const inputStyle = getComputedStyle(input);
    return {
      focused: document.activeElement === input,
      border: dockStyle.borderColor,
      outline:
        inputStyle.outlineStyle !== 'none' &&
        parseFloat(inputStyle.outlineWidth) > 0,
    };
  });
  assert(cue.focused, `${label}: page prompt did not receive focus`);
  assert(
    before !== cue.border || cue.outline,
    `${label}: page prompt has no distinct focus border or outline`,
  );
  await contrast(page, `${label}-focused-dock`);
}

try {
  const edge =
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let executablePath;
  try {
    await access(edge);
    executablePath = edge;
  } catch {
    /* Use installed Playwright Chromium on other platforms. */
  }
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  for (const id of ids) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    const picker = page.getByRole('combobox', { name: 'Color theme' });
    await picker.selectOption(id);
    await page.reload();
    await picker.waitFor();
    assert.equal(await picker.inputValue(), id);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      id,
    );
    await page
      .getByRole('button', { name: /Theme transcript fixture/ })
      .click();
    await page.locator('.chat-bubble.user pre').waitFor();
    await page
      .getByRole('textbox', { name: 'Message your Dot' })
      .fill('Typed message stays readable');
    await picker.focus();
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await headerFits(page);
      await contrast(page, `${id}-${width}-chat`);
      await transcript(page, `${id}-${width}-chat`);
      await capture(page, `${id}-${width}-chat`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole('button', { name: 'Open settings', exact: true })
      .click();
    await page.getByRole('dialog').waitFor();
    await contrast(page, `${id}-settings`);
    await page.getByRole('checkbox').first().uncheck();
    await contrast(page, `${id}-settings-permission-off`);
    await page.getByRole('button', { name: 'Close dialog' }).hover();
    await contrast(page, `${id}-settings-hover`);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('button', {
        name: 'Edit Long Dot name for narrow phone navigation settings',
      })
      .click();
    await page
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Typed text stays readable');
    await contrast(page, `${id}-typed-modal`);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.route('**/api/settings', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Verification error: an action could not be saved.',
        }),
      }),
    );
    await page.getByRole('button', { name: 'Pause all Dots' }).click();
    await page.getByRole('alert').waitFor();
    await contrast(page, `${id}-error-banner`);
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await page.unroute('**/api/settings');
    await page
      .getByRole('button', { name: 'Show computer', exact: true })
      .click();
    await page.locator('.computer-panel').waitFor();
    await contrast(page, `${id}-computer`);
    await page
      .getByRole('button', { name: 'Hide computer', exact: true })
      .click();
    await page.goto(`${origin}/#/spaces/${space.id}`);
    await page.locator('.space-library').waitFor();
    await contrast(page, `${id}-library`);
    await page.goto(`${origin}/#/spaces/${space.id}/pages/${document.id}`);
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    await page.locator('.document-prose[contenteditable=true]').waitFor();
    await page.locator('.document-chat-dock').waitFor();
    await focusDock(page, `${id}-1440-editor`);
    await contrast(page, `${id}-editor`);
    await capture(page, `${id}-editor`);
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await headerFits(page);
      await focusDock(page, `${id}-${width}-editor`);
      await contrast(page, `${id}-${width}-editor`);
      await capture(page, `${id}-${width}-editor`);
    }
    assert.deepEqual(errors, [], `${id}: browser runtime errors`);
    await context.close();
  }
  // Hold the React bundle: a screenshot/readback must already be Alpine under
  // the production CSP. This catches a late main.tsx assignment passing falsely.
  for (const scenario of ['system-dark', 'invalid-saved', 'storage-denied']) {
    const context = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: 320, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (scenario === 'invalid-saved')
      await page.addInitScript(() =>
        localStorage.setItem('opendots-theme', 'invalid'),
      );
    if (scenario === 'storage-denied')
      await page.addInitScript(() => {
        for (const key of ['localStorage', 'sessionStorage'])
          Object.defineProperty(window, key, {
            get() {
              throw new DOMException('Storage blocked', 'SecurityError');
            },
          });
      });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/assets/*.js', async (route) => {
      await gate;
      await route.continue();
    });
    const navigation = page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'alpine',
    );
    assert.equal(await page.locator('#root').textContent(), '');
    await capture(page, `${scenario}-prepaint`);
    release();
    await navigation;
    await page.getByRole('combobox', { name: 'Color theme' }).waitFor();
    await headerFits(page);
    await contrast(page, scenario);
    await page
      .getByRole('combobox', { name: 'Color theme' })
      .selectOption('coastal');
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      'coastal',
    );
    assert.deepEqual(errors, [], `${scenario}: browser runtime errors`);
    await context.close();
  }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ screenshots, receipt }, null, 2),
  );
  const failures = receipt.filter((scan) => scan.failures.length);
  assert.deepEqual(
    failures,
    [],
    `Rendered contrast failures: ${JSON.stringify(failures)}`,
  );
  console.log(
    `Theme verification passed: ${receipt.length} rendered contrast scans, ${screenshots} screenshots, five themes, 320/375/1440px, persisted user/assistant Markdown, focused document chat, persistence, CSP prepaint, denied storage.`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  workspace.close();
  store.close();
}
