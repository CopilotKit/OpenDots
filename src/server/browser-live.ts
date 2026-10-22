import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { McpTools } from './mcp-tools.js';
import { execFileSync, spawn } from 'node:child_process';

function chromeExecutable() {
  for (const exe of ['chrome.exe', 'msedge.exe'])
    for (const hive of ['HKCU', 'HKLM'])
      try {
        const out = execFileSync(
          'reg',
          [
            'query',
            `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
            '/ve',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const path = out.match(/REG_SZ\s+(.+)/)?.[1]?.trim();
        if (path) return path;
      } catch {
        // Not registered in this hive.
      }
  throw new Error('Chrome or Edge is not installed.');
}

// Live view of the Dots' browser (launched by localtools with a local DevTools
// port). OpenDots attaches to the same browser to stream frames into the side
// panel and to relay the owner's input while they have taken control.
export interface LiveFrame {
  data: string;
  url: string;
  title: string;
  width: number;
  height: number;
  takeover: boolean;
}

export class LiveBrowser {
  private browser?: Browser;
  private active?: Page;
  private connecting?: Promise<Browser | undefined>;
  readonly takeoverFile: string;
  constructor(
    private cdpUrl = process.env.LOCALTOOLS_CDP_URL ?? 'http://127.0.0.1:9333',
    takeoverFile = process.env.LOCALTOOLS_TAKEOVER_FILE ??
      'localtools/output/browser-takeover.flag',
    private mcp?: McpTools,
    private profile = resolve(
      process.env.LOCALTOOLS_BROWSER_PROFILE ?? 'localtools/browser-profile',
    ),
  ) {
    this.takeoverFile = resolve(takeoverFile);
  }
  get takeover() {
    return existsSync(this.takeoverFile);
  }
  /**
   * Opens the Dots' profile in a plain Chrome window with no DevTools port, for
   * sign-ins that refuse any controlled browser. Logins are saved to the
   * profile; close the window and the Dots use them on their next start.
   */
  async signInWindow(url: string) {
    const browser = await this.connect();
    if (browser) {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => undefined);
      for (let i = 0; i < 40 && (await this.connect()); i++)
        await new Promise((done) => setTimeout(done, 250));
    }
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    spawn(
      chromeExecutable(),
      [
        `--user-data-dir=${this.profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        target,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
  }
  setTakeover(on: boolean) {
    if (on) {
      mkdirSync(dirname(this.takeoverFile), { recursive: true });
      writeFileSync(this.takeoverFile, String(Date.now()));
    } else rmSync(this.takeoverFile, { force: true });
  }
  private async connect(): Promise<Browser | undefined> {
    if (this.browser?.isConnected()) return this.browser;
    this.connecting ??= chromium
      .connectOverCDP(this.cdpUrl, { timeout: 3000 })
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => (this.browser = undefined));
        // Follow whichever tab most recently navigated or was opened.
        const track = (page: Page) => {
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) this.active = page;
          });
          page.on('close', () => {
            if (this.active === page) this.active = undefined;
          });
        };
        for (const context of browser.contexts()) {
          context.pages().forEach(track);
          context.on('page', (page) => {
            track(page);
            this.active = page;
          });
        }
        return browser;
      })
      .catch(() => undefined)
      .finally(() => (this.connecting = undefined));
    return this.connecting;
  }
  /** Starts the Dots' browser through the local tools if it is not running. */
  async start(url = 'about:blank') {
    if (await this.connect())
      return this.goto(url === 'about:blank' ? '' : url);
    if (!this.mcp) throw new Error('Local tools are not configured.');
    await this.mcp.call('localtools', 'browser_open', { url });
    if (!(await this.connect()))
      throw new Error('The browser started but its live view is unavailable.');
  }
  /** The tab being worked on: last navigated, else a visible non-blank tab. */
  async page(): Promise<Page | undefined> {
    const browser = await this.connect();
    if (!browser) return undefined;
    if (this.active && !this.active.isClosed()) return this.active;
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .sort(
        (a, b) =>
          Number(b.url() !== 'about:blank') - Number(a.url() !== 'about:blank'),
      );
    for (const page of pages) {
      try {
        if ((await page.evaluate(() => document.visibilityState)) === 'visible')
          return page;
      } catch {
        // Page navigating or closed; try the next one.
      }
    }
    return pages[0];
  }
  /** One local-tools browser tool run for the owner (no model involved), as JSON. */
  private async tool(name: string, args: Record<string, unknown> = {}) {
    if (!this.mcp) throw new Error('Local tools are not configured.');
    const response = (await this.mcp.call('localtools', name, args)) as {
      structuredContent?: Record<string, unknown>;
      content?: { type: string; text?: string }[];
    };
    if (response.structuredContent) {
      const keys = Object.keys(response.structuredContent);
      return (
        keys.length === 1 && keys[0] === 'result'
          ? response.structuredContent.result
          : response.structuredContent
      ) as Record<string, unknown>;
    }
    const text = response.content?.find((part) => part.type === 'text')?.text;
    try {
      return JSON.parse(text ?? '{}') as Record<string, unknown>;
    } catch {
      return { text };
    }
  }
  /**
   * Point the local tools at the tab the owner is viewing, so teaching and the
   * saved-button list apply to the page on screen.
   */
  private async followViewedTab() {
    const page = await this.require();
    const { tabs } = (await this.tool('browser_tabs')) as {
      tabs?: { index: number; url: string; active: boolean }[];
    };
    if (!tabs || tabs.find((tab) => tab.active)?.url === page.url()) return;
    const match = tabs.find((tab) => tab.url === page.url());
    if (match) await this.tool('browser_switch_tab', { index: match.index });
  }
  /** Start owner teaching: their next click in the view marks the target. */
  async teachStart(name: string, kind: 'button' | 'region', afterClicks = 0) {
    // Tab switching is refused while the owner has control; teach where it is.
    await this.followViewedTab().catch(() => undefined);
    return this.tool('browser_teach_start', {
      name,
      kind,
      selection: kind === 'region' ? 'area' : 'click',
      ...(afterClicks > 0 ? { after_clicks: afterClicks } : {}),
    });
  }
  teachStatus() {
    return this.tool('browser_teach_status');
  }
  teachFinish() {
    return this.tool('browser_teach_finish');
  }
  teachCancel() {
    return this.tool('browser_teach_cancel');
  }
  /** The latest pair scan the local tools saved (by the owner or a Dot). */
  pairScan(
    file = process.env.LOCALTOOLS_PAIR_SCAN_FILE ??
      'localtools/output/pair-scan.json',
  ): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  }
  /** The trading session the local tools keep: start, peak and locked profit. */
  tradingSession(
    file = process.env.LOCALTOOLS_TRADING_SESSION_FILE ??
      'localtools/output/trading-session.json',
  ) {
    return this.pairScan(file) as {
      time?: number;
      start?: number;
      peak?: number;
      locked?: number | null;
    };
  }
  /** Rate the top pairs and leave the chart on the clearest trend. */
  scanPairs(count = 8, market: 'otc' | 'real' | 'same' = 'same') {
    return this.tool('browser_scan_pairs', {
      count,
      market,
      ...(market === 'real' ? { expiry: '1m' } : {}),
    });
  }
  /** Switch the trading tab to a pair, for the owner and the Dots alike. */
  choosePair(name: string) {
    return this.tool('browser_choose_asset', { name });
  }
  /** Buttons and areas the owner taught for the page on screen. */
  async targets() {
    if (!(await this.page())) return { targets: [] };
    // Switching tabs is refused while the owner has control or a teach is open.
    await this.followViewedTab().catch(() => undefined);
    return this.tool('browser_targets');
  }
  async forgetTarget(id: string) {
    await this.followViewedTab().catch(() => undefined);
    return this.tool('browser_target_forget', { target_id: id });
  }
  /** Visible text of the page on screen, so code can read facts such as the balance. */
  async pageText(): Promise<string | undefined> {
    const page = await this.page();
    if (!page) return undefined;
    return page
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => undefined);
  }
  /** Names of taught targets on the current page, for a run's instructions. */
  async targetNames(): Promise<string[]> {
    if (!this.mcp || !(await this.page())) return [];
    const { targets } = (await this.tool('browser_targets')) as {
      targets?: { name?: string; kind?: string }[];
    };
    return (targets ?? [])
      .filter((target) => target.name)
      .map((target) =>
        target.kind && target.kind !== 'button'
          ? `${target.name} (${target.kind})`
          : String(target.name),
      );
  }
  async status() {
    const page = await this.page();
    return page
      ? {
          running: true,
          url: page.url(),
          title: await page.title().catch(() => ''),
          takeover: this.takeover,
        }
      : { running: false, url: '', title: '', takeover: this.takeover };
  }
  /** Streams JPEG frames of the active tab until the signal aborts. */
  async stream(onFrame: (frame: LiveFrame) => void, signal: AbortSignal) {
    let session: CDPSession | undefined;
    let current: Page | undefined;
    let meta = { width: 0, height: 0 };
    const attach = async () => {
      const page = await this.page();
      if (!page || page === current) return;
      await session?.detach().catch(() => undefined);
      current = page;
      session = await page.context().newCDPSession(page);
      session.on('Page.screencastFrame', (frame) => {
        meta = {
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
        };
        void session
          ?.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => undefined);
        onFrame({
          data: frame.data,
          url: page.url(),
          title: '',
          ...meta,
          takeover: this.takeover,
        });
      });
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1600,
        maxHeight: 1000,
        everyNthFrame: 1,
      });
    };
    while (!signal.aborted) {
      try {
        await attach();
      } catch {
        current = undefined;
      }
      // Re-check the active tab; also keeps the stream alive across restarts.
      await new Promise((done) => setTimeout(done, 1000));
    }
    await session?.send('Page.stopScreencast').catch(() => undefined);
    await session?.detach().catch(() => undefined);
  }
  async goto(url: string) {
    const page = await this.require();
    if (!url) return;
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  async navigate(action: 'back' | 'forward' | 'reload') {
    const page = await this.require();
    if (action === 'back') await page.goBack({ timeout: 20_000 });
    else if (action === 'forward') await page.goForward({ timeout: 20_000 });
    else await page.reload({ timeout: 30_000 });
  }
  /** Owner input, in page CSS pixels. Only allowed while the owner has control. */
  async input(
    event:
      | { type: 'click'; x: number; y: number; button?: 'left' | 'right' }
      | { type: 'wheel'; dx: number; dy: number }
      | { type: 'key'; key: string }
      | { type: 'text'; text: string },
  ) {
    if (!this.takeover)
      throw new Error('Take control of the browser before interacting.');
    const page = await this.require();
    if (event.type === 'click')
      await page.mouse.click(event.x, event.y, { button: event.button });
    else if (event.type === 'wheel') {
      await page.mouse.wheel(event.dx, event.dy);
    } else if (event.type === 'key') await page.keyboard.press(event.key);
    else await page.keyboard.insertText(event.text);
  }
  private async require() {
    const page = await this.page();
    if (!page) throw new Error('The browser is not running. Start it first.');
    return page;
  }
  async close() {
    await this.browser?.close().catch(() => undefined);
  }
}
