import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { chat } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { harnessAdapterFor } from '../src/server/model-adapters.js';
import { resolveModel } from '../src/server/models.js';
import { assertHarnessRuntime } from '../src/server/harness-runtime.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

type Provider = 'claude-code' | 'codex';
type Receipt = {
  provider: Provider;
  phase: 'auth' | 'turn';
  args: string[];
  cwd: string;
  pid: number;
  homePresent: boolean;
  home?: string;
  present: string[];
};
const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
const controllers: Array<{ abortRun(): void }> = [];
const scrubKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
  'INTELLIGENCE_API_KEY',
  'SLACK_BOT_TOKEN',
  'OPENDOTS_OWNER_TOKEN',
  'BROWSER_SECRET',
  'VARLOCK_TEST',
  '__VARLOCK_ENV',
  '__VARLOCK_RUN',
  'DMNO_TEST',
  'NODE_OPTIONS',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
];

afterEach(async () => {
  controllers.splice(0).forEach((agent) => agent.abortRun());
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()))
      throw new Error('Unexpected test temp directory');
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

function shellQuote(value: string) {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

async function fixture(
  provider: Provider,
  options: {
    auth?: 'subscription' | 'api-key' | 'logged-out' | 'missing' | 'hang';
    turn?: 'complete' | 'error' | 'hang' | 'tools';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opendots-harness-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await Promise.all([mkdir(bin), mkdir(home)]);
  const receipts = join(root, 'receipts.jsonl');
  const heartbeat = join(root, 'heartbeat');
  const configFile = join(root, 'fixture.json');
  const bridgeReceipts = join(root, 'bridge.json');
  await writeFile(
    configFile,
    JSON.stringify({
      receipts,
      heartbeat,
      scrubKeys,
      testHome: home,
      bridgeReceipts,
      auth: options.auth ?? 'subscription',
      turn: options.turn ?? 'complete',
    }),
  );
  const cli = fileURLToPath(
    new URL('./fixtures/fake-harness-cli.mjs', import.meta.url),
  );
  for (const [name, kind] of [
    ['claude', 'claude-code'],
    ['codex', 'codex'],
  ]) {
    const shim = join(bin, name);
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} ${kind} "$@"\n`,
    );
    await chmod(shim, 0o755);
  }
  const systemPath =
    process.platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
      : ['/usr/bin', '/bin'];
  vi.stubEnv(
    'PATH',
    [bin, dirname(process.execPath), ...systemPath].join(delimiter),
  );
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('OPENDOTS_CONTAINER', 'false');
  vi.stubEnv('OPENDOTS_TEST_HARNESS_FIXTURE', configFile);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'));
  for (const key of scrubKeys)
    vi.stubEnv(
      key,
      key === 'NODE_OPTIONS' ? '--no-warnings' : 'synthetic-secret-for-test',
    );
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  const threadId = '../outside/thread';
  workspace.bindThread(threadId, dot.id, 'Harness fixture');
  const config: PlatformConfig = {
    intelligenceKey: 'synthetic-intelligence-key',
    apiKey: 'synthetic-api-key',
    anthropicKey: 'synthetic-anthropic-key',
    modelProvider: provider,
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    claudeModel: 'fixture-claude-model',
    claudeCwd: join(root, 'workspaces'),
    claudePermissionMode: 'acceptEdits',
    codexModel: 'fixture-codex-model',
    codexCwd: join(root, 'workspaces'),
  };
  const agent = new DotAgent(store, workspace, config, dot.id);
  controllers.push(agent);
  const input: RunAgentInput = {
    threadId,
    runId: 'fixture-run',
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [
      { id: 'user', role: 'user', content: 'Reply with a short sentence.' },
    ],
  };
  const readReceipts = async (): Promise<Receipt[]> => {
    const text = await readFile(receipts, 'utf8').catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  };
  return {
    root,
    bridgeReceipts,
    heartbeat,
    agent,
    store,
    workspace,
    dot,
    input,
    config,
    readReceipts,
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.each<Provider>(['claude-code', 'codex'])(
  '%s installed SDK and local subprocess',
  (provider) => {
    it('never launches CLI auth with a preaborted scope signal even without an outer chat controller', async () => {
      const f = await fixture(provider);
      const controller = new AbortController();
      controller.abort();
      const resolved = resolveModel({
        provider,
        claudeModel: 'fixture-claude-model',
        claudeCwd: join(f.root, 'workspaces'),
        codexModel: 'fixture-codex-model',
        codexCwd: join(f.root, 'workspaces'),
      });
      const runtime = await harnessAdapterFor(resolved, {
        dotId: f.dot.id,
        threadId: f.input.threadId,
        signal: controller.signal,
      });
      const stream =
        runtime.kind === 'claude-code'
          ? chat({
              adapter: runtime.adapter,
              middleware: [runtime.middleware],
              messages: [{ role: 'user', content: 'Never launch auth.' }],
            })
          : chat({
              adapter: runtime.adapter,
              middleware: [runtime.middleware],
              messages: [{ role: 'user', content: 'Never launch auth.' }],
            });
      const chunkTypes: string[] = [];
      await expect(async () => {
        for await (const event of stream) chunkTypes.push(event.type);
      }).rejects.toThrow(/abort/i);
      expect(chunkTypes.length).toBeLessThan(5);
      expect(await f.readReceipts()).toEqual([]);
    }, 15_000);
    it('keeps different Dots and threads in distinct directories even with path traversal IDs', async () => {
      const f = await fixture(provider);
      await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      const secondThread = '../../outside/second';
      f.workspace.bindThread(secondThread, f.dot.id, 'Second thread');
      await lastValueFrom(
        f.agent
          .run({ ...f.input, threadId: secondThread, runId: 'run-2' })
          .pipe(toArray()),
      );
      const secondDot = f.workspace.createDot(
        f.dot.spaceId,
        'Second Dot',
        'Reply briefly.',
        false,
        false,
      );
      const thirdThread = '..\\..\\outside\\third';
      f.workspace.bindThread(thirdThread, secondDot.id, 'Third thread');
      const secondAgent = new DotAgent(
        f.store,
        f.workspace,
        f.config,
        secondDot.id,
      );
      controllers.push(secondAgent);
      await lastValueFrom(
        secondAgent
          .run({ ...f.input, threadId: thirdThread, runId: 'run-3' })
          .pipe(toArray()),
      );
      const turns = (await f.readReceipts()).filter(
        (receipt) => receipt.phase === 'turn',
      );
      expect(turns).toHaveLength(3);
      expect(new Set(turns.map((row) => row.cwd)).size).toBe(3);
      for (const row of turns) {
        expect(dirname(row.cwd)).toBe(join(f.root, 'workspaces'));
        expect(row.cwd.slice(-64)).toMatch(/^[a-f0-9]{64}$/);
      }
    }, 20_000);
    it('executes authorized page tools through the actual MCP bridge and refuses a foreign Space', async () => {
      const f = await fixture(provider, { turn: 'tools' });
      const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(
        events.filter((event) => event.type === EventType.RUN_STARTED),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === EventType.RUN_FINISHED),
      ).toHaveLength(1);
      expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Bridge-created page',
            content: '# From a real CLI subprocess',
          }),
        ]),
      );
      expect(
        f.workspace.pages
          .list(f.dot.spaceId)
          .some((page) => page.title === 'Forbidden page'),
      ).toBe(false);
      const bridge = JSON.parse(await readFile(f.bridgeReceipts, 'utf8'));
      expect(bridge.denied.result).toMatchObject({ isError: true });
      expect(JSON.stringify(bridge.denied)).toMatch(/revoked|not.*granted/i);
      expect(bridge.allowed.result.isError).not.toBe(true);
    }, 15_000);
    it('streams an actual CLI turn with subscription auth, scoped cwd, scrubbed secrets and native policy arguments', async () => {
      const f = await fixture(provider);
      const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: EventType.RUN_STARTED }),
          expect.objectContaining({ type: EventType.RUN_FINISHED }),
          expect.objectContaining({
            type: EventType.TEXT_MESSAGE_CHUNK,
            delta: 'Local subscription turn completed.',
          }),
        ]),
      );
      const receipts = await f.readReceipts();
      expect(receipts.map((row) => row.phase)).toEqual(['auth', 'turn']);
      for (const row of receipts) {
        expect(row.present).toEqual([]);
        expect(dirname(row.cwd)).toBe(join(f.root, 'workspaces'));
        expect(row.cwd.slice(-64)).toMatch(/^[a-f0-9]{64}$/);
        expect(alive(row.pid)).toBe(false);
      }
      expect(receipts[0].cwd).toBe(receipts[1].cwd);
      const args = receipts[1].args;
      expect(args.join(' ')).not.toMatch(
        /max.?iterations|max.?completion.?tokens|max.?turns/i,
      );
      if (provider === 'claude-code') {
        expect(receipts[0].args).toEqual(['auth', 'status', '--json']);
        expect(args).toEqual(
          expect.arrayContaining([
            '--setting-sources',
            'project',
            '--permission-mode',
            'acceptEdits',
            '--model',
            'fixture-claude-model',
          ]),
        );
        expect(args).not.toContain('--bare');
      } else {
        expect(receipts[0].args).toEqual(['login', 'status']);
        expect(args).toEqual(
          expect.arrayContaining([
            'exec',
            '--experimental-json',
            '--sandbox',
            'workspace-write',
            'approval_policy="never"',
            'web_search="disabled"',
            '--model',
            'fixture-codex-model',
          ]),
        );
        expect(args).not.toContain('--cd');
      }
    }, 15_000);

    it.each(['api-key', 'logged-out'] as const)(
      'refuses native %s login even when server API keys are configured',
      async (auth) => {
        const f = await fixture(provider, { auth });
        const events = await lastValueFrom(
          f.agent.run(f.input).pipe(toArray()),
        );

        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: EventType.RUN_ERROR,
              threadId: f.input.threadId,
              runId: f.input.runId,
              message: expect.stringMatching(
                /subscription login is required.*(?:claude auth login|codex login)/i,
              ),
            }),
          ]),
        );
        expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
          'auth',
        ]);
        expect(JSON.stringify(events)).not.toContain(
          'synthetic-secret-for-test',
        );
        expect(JSON.stringify(events)).not.toContain('synthetic-api-key');
      },
      15_000,
    );

    it('reports an unavailable native CLI with installation guidance before starting a turn', async () => {
      const f = await fixture(provider, { auth: 'missing' });
      const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: EventType.RUN_ERROR,
            threadId: f.input.threadId,
            runId: f.input.runId,
            message: expect.stringMatching(
              /install.*(?:claude|codex)|(?:claude|codex).*install/i,
            ),
          }),
        ]),
      );
      expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
        'auth',
      ]);
    }, 15_000);

    it('surfaces a failed CLI turn without leaking server credentials', async () => {
      const f = await fixture(provider, { turn: 'error' });
      const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: EventType.RUN_ERROR,
            threadId: f.input.threadId,
            runId: f.input.runId,
            message: expect.stringContaining(
              'subscription CLI could not complete',
            ),
          }),
        ]),
      );
      expect(JSON.stringify(events)).not.toContain('synthetic-secret-for-test');
      expect(JSON.stringify(events)).not.toContain('synthetic-api-key');
      const errors = events.filter(
        (event) => event.type === EventType.RUN_ERROR,
      );
      expect(errors).toHaveLength(1);
      expect(Object.keys(errors[0]).sort()).toEqual([
        'message',
        'runId',
        'threadId',
        'type',
      ]);
      for (const row of await f.readReceipts())
        expect(alive(row.pid)).toBe(false);
    }, 15_000);

    it('promptly kills a stalled auth preflight when the owner cancels, without launching a turn', async () => {
      const f = await fixture(provider, { auth: 'hang' });
      const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      void finished.catch(() => undefined);
      await vi.waitFor(
        async () =>
          expect(
            (await f.readReceipts()).some((row) => row.phase === 'auth'),
          ).toBe(true),
        { timeout: 8000, interval: 50 },
      );
      const child = (await f.readReceipts()).find(
        (row) => row.phase === 'auth',
      );
      if (!child) throw new Error('The auth preflight child did not start');
      expect(alive(child.pid)).toBe(true);
      await vi.waitFor(
        async () =>
          expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
        { timeout: 2000, interval: 50 },
      );
      f.agent.abortRun();
      // This deadline is well below the separate ten-second login timeout.
      await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
        timeout: 4000,
        interval: 50,
      });
      const events = await finished;
      expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
        'auth',
      ]);
      const stopped = await readFile(f.heartbeat, 'utf8');
      await new Promise((done) => setTimeout(done, 120));
      expect(await readFile(f.heartbeat, 'utf8')).toBe(stopped);
      for (const event of events.filter(
        (event) => event.type === EventType.RUN_ERROR,
      )) {
        expect(event).toMatchObject({
          threadId: f.input.threadId,
          runId: f.input.runId,
        });
        expect(Object.keys(event).sort()).toEqual([
          'message',
          'runId',
          'threadId',
          'type',
        ]);
        expect(JSON.stringify(event)).not.toContain(
          'synthetic-secret-for-test',
        );
        expect(JSON.stringify(event)).not.toContain('synthetic-api-key');
        if ('message' in event && typeof event.message === 'string')
          expect(event.message.length).toBeLessThan(500);
      }
    }, 15_000);

    it.each(['pause', 'cancel'] as const)(
      'kills the actual CLI subprocess when the owner requests %s',
      async (action) => {
        const f = await fixture(provider, { turn: 'hang' });
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
        // Mark the promise handled immediately; a startup failure is rethrown by await below.
        void finished.catch(() => undefined);
        await vi.waitFor(
          async () =>
            expect(
              (await f.readReceipts()).some((row) => row.phase === 'turn'),
            ).toBe(true),
          { timeout: 8000, interval: 50 },
        );
        const child = (await f.readReceipts()).find(
          (row) => row.phase === 'turn',
        );
        if (!child) throw new Error('The CLI child did not start');
        expect(alive(child.pid)).toBe(true);
        await vi.waitFor(
          async () =>
            expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
          { timeout: 2000, interval: 50 },
        );
        if (action === 'pause') f.store.updateSettings({ paused: true });
        else f.agent.abortRun();
        await finished;
        await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
          timeout: 5000,
          interval: 50,
        });
        const stopped = await readFile(f.heartbeat, 'utf8');
        await new Promise((done) => setTimeout(done, 120));
        expect(await readFile(f.heartbeat, 'utf8')).toBe(stopped);
      },
      20_000,
    );
  },
);

it.skipIf(process.platform !== 'win32')(
  'uses synthetic USERPROFILE for both Claude login checks and the CLI turn when HOME is absent on Windows',
  async () => {
    const f = await fixture('claude-code');
    vi.stubEnv('HOME', undefined);
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    const receipts = await f.readReceipts();
    expect(receipts.map((row) => row.phase)).toEqual(['auth', 'turn']);
    for (const row of receipts) {
      expect(row.homePresent).toBe(true);
      expect(row.home).toBe(join(f.root, 'home'));
    }
  },
  15_000,
);

it.each([
  { nodeEnv: 'production', host: '127.0.0.1', container: false },
  { nodeEnv: 'development', host: '0.0.0.0', container: false },
  { nodeEnv: 'development', host: '127.0.0.1', container: true },
])(
  'rejects unsafe harness runtime %j before loading a CLI',
  async (environment) => {
    expect(() =>
      assertHarnessRuntime({ provider: 'claude-code', ...environment }),
    ).toThrow(/local development on a loopback/);
    expect(() =>
      assertHarnessRuntime({ provider: 'codex', ...environment }),
    ).toThrow(/local development on a loopback/);
    expect(() =>
      assertHarnessRuntime({ provider: 'openai', ...environment }),
    ).not.toThrow();
    const f = await fixture('codex');
    vi.stubEnv('NODE_ENV', environment.nodeEnv);
    vi.stubEnv('HOST', environment.host);
    vi.stubEnv('OPENDOTS_CONTAINER', String(environment.container));
    await expect(
      harnessAdapterFor(
        resolveModel({ provider: 'codex', codexModel: 'fixture-model' }),
        { dotId: '../dot', threadId: '../thread' },
      ),
    ).rejects.toThrow(/local development on a loopback/);
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        threadId: f.input.threadId,
        runId: f.input.runId,
        message: expect.stringMatching(/local development on a loopback/),
      }),
    ]);
    expect(await f.readReceipts()).toEqual([]);
  },
);
