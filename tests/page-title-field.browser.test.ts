// Browser regression: the fitted title height must follow width changes.
// Uses esbuild to bundle the real component and Playwright Chromium for real
// layout, since SSR or jsdom cannot reproduce textarea wrapping/clipping.
import { buildSync } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';

const LONG_TITLE =
  'AI Coworkers: OpenAI Dots vs Meta Muse vs OpenDots compared in depth';

async function launchTitleBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Executable doesn't exist at")
    ) {
      throw error;
    }
    // Hosted CI images include Chrome even when Playwright's cache is empty.
    // Playwright still creates a fresh temporary profile for this launch.
    return chromium.launch({ channel: 'chrome' });
  }
}

it('falls back to Chrome when the bundled Chromium executable is missing', async () => {
  const browser = {} as Awaited<ReturnType<typeof chromium.launch>>;
  const launch = vi
    .spyOn(chromium, 'launch')
    .mockRejectedValueOnce(
      new Error("Executable doesn't exist at /cache/chromium"),
    )
    .mockResolvedValueOnce(browser);
  try {
    expect(await launchTitleBrowser()).toBe(browser);
    expect(launch.mock.calls).toEqual([[], [{ channel: 'chrome' }]]);
  } finally {
    launch.mockRestore();
  }
});

it('does not hide other browser launch failures with a fallback', async () => {
  const launch = vi
    .spyOn(chromium, 'launch')
    .mockRejectedValue(new Error('browser sandbox failed'));
  try {
    await expect(launchTitleBrowser()).rejects.toThrow(
      'browser sandbox failed',
    );
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
});

function buildHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'title-field-'));
  const entry = join(dir, 'entry.tsx');
  writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { PageTitleField } from '${join(process.cwd(), 'src/client/editor/PageTitleField')}';
createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100%' }}>
    <PageTitleField value=${JSON.stringify(LONG_TITLE)} onChange={() => {}} />
  </div>,
);
`,
  );
  const bundle = join(dir, 'bundle.js');
  buildSync({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(process.cwd(), 'node_modules')],
  });
  const css = readFileSync(
    join(process.cwd(), 'src/client/editor.css'),
    'utf8',
  );
  const titleRule =
    css.match(/\.document-title\s*\{[^}]*\}/)?.[0] ??
    (() => {
      throw new Error('document-title rule not found');
    })();
  return `<!doctype html><html><head><style>
body { margin: 0; font-family: sans-serif; }
${titleRule}
</style></head><body><div id="root"></div><script>${readFileSync(bundle, 'utf8')}</script></body></html>`;
}

it('recalculates the fitted title height when the field width shrinks', async () => {
  const browser = await launchTitleBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(buildHarness());
    const field = page.locator('.document-title');
    await field.waitFor();
    const before = await field.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    expect(before.scroll).toBeLessThanOrEqual(before.client);

    await page.setViewportSize({ width: 375, height: 900 });
    // Give the observer a couple of frames to deliver the resize.
    await page.waitForTimeout(200);
    const after = await field.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    // Narrower field wraps the title onto more lines, so the fitted height
    // must grow; if it stays stale, overflow:hidden clips the last line.
    expect(after.scroll).toBeGreaterThan(before.scroll);
    expect(after.client).toBeGreaterThanOrEqual(after.scroll);
  } finally {
    await browser.close();
  }
}, 60_000);
