import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserRoutes } from '../src/server/browser-routes.js';
import { LiveBrowser } from '../src/server/browser-live.js';
import type { McpTools } from '../src/server/mcp-tools.js';

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('pairs dashboard routes', () => {
  it('scans and switches pairs through the local tools', async () => {
    const calls: unknown[][] = [];
    const mcp = {
      call: async (server: string, tool: string, args: unknown) => {
        calls.push([server, tool, args]);
        return { structuredContent: { now_on: 'GBP/JPY OTC' } };
      },
    } as unknown as McpTools;
    const app = browserRoutes(new LiveBrowser(undefined, undefined, mcp));
    expect(
      await (
        await app.request('/browser/pairs/scan', post({ count: 6 }))
      ).json(),
    ).toEqual({ now_on: 'GBP/JPY OTC' });
    await app.request('/browser/pairs/scan', post({ market: 'real' }));
    await app.request('/browser/pairs/choose', post({ name: 'EUR/USD OTC' }));
    expect(
      (await app.request('/browser/pairs/choose', post({ name: '' }))).status,
    ).toBe(400);
    expect(calls).toEqual([
      ['localtools', 'browser_scan_pairs', { count: 6, market: 'same' }],
      [
        'localtools',
        'browser_scan_pairs',
        { count: 8, market: 'real', expiry: '1m' },
      ],
      ['localtools', 'browser_choose_asset', { name: 'EUR/USD OTC' }],
    ]);
  });
  it('switches obvious-turns-only mode on and off through a settings file', () => {
    const live = new LiveBrowser();
    const file = join(
      mkdtempSync(join(tmpdir(), 'mode-')),
      'trading-mode.json',
    );
    expect(live.tradingMode(file)).toEqual({ obviousOnly: false });
    expect(live.setTradingMode(true, file)).toEqual({ obviousOnly: true });
    expect(live.tradingMode(file)).toEqual({ obviousOnly: true });
    live.setTradingMode(false, file);
    expect(live.tradingMode(file)).toEqual({ obviousOnly: false });
  });
  it('reads the latest saved scan, or nothing before the first', () => {
    const live = new LiveBrowser();
    const dir = mkdtempSync(join(tmpdir(), 'pairs-'));
    const file = join(dir, 'pair-scan.json');
    expect(live.pairScan(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ now_on: 'AUD/CAD OTC', pairs: [] }));
    expect(live.pairScan(file)).toEqual({ now_on: 'AUD/CAD OTC', pairs: [] });
  });
});
