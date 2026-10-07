import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  DEFAULT_AGENT_RUN_TIMEOUT_MS,
  agentRunTimeoutMsFromEnv,
} from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const resources: Array<{ close(): void }> = [];
function sharedStores() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-timeout-'));
  const path = join(dir, 'test.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  resources.push(first, second, {
    close: () => rmSync(dir, { recursive: true, force: true }),
  });
  return { first, second };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resources.splice(0).forEach((resource) => resource.close());
});

it('uses 90 seconds by default and accepts a positive integer override', () => {
  expect(agentRunTimeoutMsFromEnv({})).toBe(DEFAULT_AGENT_RUN_TIMEOUT_MS);
  expect(agentRunTimeoutMsFromEnv({ AGENT_RUN_TIMEOUT_MS: ' 240000 ' })).toBe(
    240_000,
  );
});

it('rejects invalid timeout overrides at startup', () => {
  for (const value of ['0', '-1', '1.5', 'not-a-number', '2147483648'])
    expect(() =>
      agentRunTimeoutMsFromEnv({ AGENT_RUN_TIMEOUT_MS: value }),
    ).toThrow(/AGENT_RUN_TIMEOUT_MS/);
});

it('uses the configured timeout for interactive Dot turns', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Timeout test');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      agentRunTimeoutMs: 1_250,
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Keep working.' }],
    tools: [],
    forwardedProps: {},
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  const finished = lastValueFrom(agent.run(input).pipe(toArray()));
  await vi.advanceTimersByTimeAsync(1_251);
  const events = await finished;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: expect.stringContaining('1.25 second time limit'),
      }),
    ]),
  );
});

it('uses the configured timeout for scheduled/background runs', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  resources.push(store);
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    store,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((_resolve, reject) => {
        signal = runSignal;
        runSignal.addEventListener('abort', () => reject(runSignal.reason), {
          once: true,
        });
      }),
    1_250,
  );
  store.createTask('Long-running task');
  const pending = runner.tick();
  await vi.advanceTimersByTimeAsync(1_251);
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(store.tasks()[0].status).toBe('failed');
});

it('completes a longer background run after another worker checks the old lease deadline', async () => {
  vi.useFakeTimers();
  const { first, second } = sharedStores();
  const result = {
    text: 'Finished after 200 seconds',
    sources: [],
    sample: true,
  };
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    first,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((resolve, reject) => {
        signal = runSignal;
        const timer = setTimeout(() => resolve(result), 200_000);
        runSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(runSignal.reason);
          },
          { once: true },
        );
      }),
    240_000,
  );
  const competingExecute = vi.fn().mockResolvedValue(result);
  const competing = new Runner(
    second,
    { mode: 'sample', baseUrl: '' },
    competingExecute,
  );
  const task = first.createTask('Long-running task');
  const pending = runner.tick();
  const lease = first.task(task.id)?.lease;
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect(second.task(task.id)?.status).toBe('running');
    expect(second.task(task.id)?.lease).toBe(lease);
    expect(signal?.aborted).toBe(false);
    expect(competingExecute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(second.task(task.id)?.status).toBe('completed');
    expect(second.detail(task.id)?.runs).toEqual([
      expect.objectContaining({ status: 'completed', result }),
    ]);
  } finally {
    runner.stop();
    competing.stop();
    await pending;
  }
});

it('still times out a longer background run after another worker checks its lease', async () => {
  vi.useFakeTimers();
  const { first, second } = sharedStores();
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    first,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((_resolve, reject) => {
        signal = runSignal;
        runSignal.addEventListener('abort', () => reject(runSignal.reason), {
          once: true,
        });
      }),
    240_000,
  );
  const competing = new Runner(second, { mode: 'sample', baseUrl: '' });
  const task = first.createTask('Long-running task');
  const pending = runner.tick();
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect(second.task(task.id)?.status).toBe('running');
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(second.task(task.id)?.status).toBe('failed');
    expect(second.detail(task.id)?.runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'Research exceeded the 240 second time limit.',
      }),
    ]);
  } finally {
    runner.stop();
    competing.stop();
    await pending;
  }
});
