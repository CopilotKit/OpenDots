import { beforeEach, expect, it, vi } from 'vitest';

const headless = vi.hoisted(() => ({ runThreadTurn: vi.fn() }));
vi.mock('../src/server/headless.js', () => ({ runThreadTurn: headless.runThreadTurn }));

import { Platform } from '../src/server/platform.js';

beforeEach(() => vi.clearAllMocks());

it('includes bounded prior thread history in headless turns for continuity', async () => {
  const platform = Object.create(Platform.prototype) as any;
  platform.requireReady = vi.fn();
  platform.workspace = {
    requireThread: vi.fn(() => ({ dotId: 'dot' })),
  };
  platform.config = { runtimeUrl: 'https://runtime.test' };
  platform.history = vi
    .fn()
    .mockResolvedValue('user: remember CONTEXT_TOKEN_7319\nassistant: CONTEXT_TOKEN_7319');
  headless.runThreadTurn.mockResolvedValue('CONTEXT_TOKEN_7319');

  const result = await platform.turn(
    'thread',
    'What was the previous token?',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );

  expect(result).toBe('CONTEXT_TOKEN_7319');
  expect(platform.history).toHaveBeenCalledWith('thread');
  expect(headless.runThreadTurn).toHaveBeenCalledWith(
    'https://runtime.test',
    {},
    'dot',
    'thread',
    expect.stringContaining('CONTEXT_TOKEN_7319'),
    expect.any(AbortSignal),
    { opendotsSource: 'scheduled_task' },
  );
});

it('keeps the current request after untrusted prior history', async () => {
  const platform = Object.create(Platform.prototype) as any;
  platform.requireReady = vi.fn();
  platform.workspace = {
    requireThread: vi.fn(() => ({ dotId: 'dot' })),
  };
  platform.config = { runtimeUrl: 'https://runtime.test' };
  platform.history = vi
    .fn()
    .mockResolvedValue('user: OLD_HERMES_RECEIPT\nassistant: OLD_HERMES_ACK');
  headless.runThreadTurn.mockResolvedValue('NEW_ANTIGRAVITY_ACK');

  await platform.turn(
    'thread',
    'WOC_EXECUTOR_RECEIPT NEW_ANTIGRAVITY_RECEIPT',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );

  const contextualPrompt = headless.runThreadTurn.mock.calls[0][4] as string;
  expect(contextualPrompt).toContain('OLD_HERMES_RECEIPT');
  expect(contextualPrompt).toMatch(
    /Untrusted prior conversation context[\s\S]*OLD_HERMES_RECEIPT[\s\S]*Current request[\s\S]*NEW_ANTIGRAVITY_RECEIPT$/,
  );
});

