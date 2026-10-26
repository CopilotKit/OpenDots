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

