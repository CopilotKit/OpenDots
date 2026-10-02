import { expect, it, vi } from 'vitest';
import type {
  ChannelIdentityContext,
  IncomingMessage,
  Thread,
} from '@copilotkit/channels';
import { HttpAgent } from '@ag-ui/client';
import { createTelegramChannel, telegramHandlers, telegramIdentity } from '../src/server/telegram-channel.js';

const config = { telegramUsers: ['12345'] };
const identity: ChannelIdentityContext = {
  provider: 'telegram',
  tenant: { id: '-100123' },
  installation: { id: 'telegram-bot' },
  actor: { id: '12345', kind: 'human' },
  conversation: { id: 'tg:-100123:user:12345', kind: 'supergroup' },
  trigger: 'message',
  event: { id: '99' },
  raw: null,
};
const message: IncomingMessage = {
  text: 'Help',
  user: { id: 'owner', name: 'Owner' },
  actor: { id: '12345', kind: 'human' },
  ref: { id: 'message' },
  platform: 'telegram',
  operation: {
    kind: 'created',
    mentioned: true,
    logicalMessageId: 'message',
    revisionId: '1',
  },
};

function fixture(paused = false) {
  const thread = {
    runAgent: vi.fn<Thread['runAgent']>(async () => undefined),
    post: vi.fn<Thread['post']>(async () => ({ id: 'reply' })),
  };
  const report = vi.fn();
  return {
    thread,
    report,
    handlers: telegramHandlers({
      config,
      ownerId: 'owner',
      paused: () => paused,
      report,
    }),
  };
}

it('requires an explicit Telegram user allowlist for the owner identity', () => {
  expect(telegramIdentity(identity, config, 'owner')?.id).toBe('owner');
  expect(
    telegramIdentity(
      { ...identity, actor: { id: '99999', kind: 'human' } },
      config,
      'owner',
    ),
  ).toBeNull();
  expect(
    telegramIdentity(
      { ...identity, actor: { id: '12345', kind: 'bot' } },
      config,
      'owner',
    ),
  ).toBeNull();
  expect(
    telegramIdentity({ ...identity, provider: 'slack' }, config, 'owner'),
  ).toBeNull();
});

it('runs allowed Telegram turns and ignores other platforms/users', async () => {
  const f = fixture();
  await f.handlers.message({ thread: f.thread, message });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);

  await f.handlers.message({
    thread: f.thread,
    message: { ...message, platform: 'slack' },
  });
  await f.handlers.message({
    thread: f.thread,
    message: {
      ...message,
      actor: { id: '99999', kind: 'human' },
    },
  });
  await f.handlers.message({
    thread: f.thread,
    message: {
      ...message,
      operation: { ...message.operation!, kind: 'deleted' },
    },
  });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
});

it('posts a safe pause notice without running the agent', async () => {
  const f = fixture(true);
  await f.handlers.mention({ thread: f.thread, message });
  expect(f.thread.post).toHaveBeenCalledWith(
    expect.stringMatching(/paused/i),
  );
  expect(f.thread.runAgent).not.toHaveBeenCalled();
});

it('does not leak provider errors into Telegram replies or reports', async () => {
  const f = fixture();
  f.thread.runAgent.mockRejectedValue(new Error('SECRET provider details'));
  await f.handlers.message({ thread: f.thread, message });
  expect(f.thread.post.mock.calls[0]?.[0]).not.toContain('SECRET');
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('SECRET');
});

it('registers a direct Telegram adapter without starting network I/O', () => {
  const channel = createTelegramChannel({
    name: 'test-telegram',
    agent: () => new HttpAgent({ url: 'http://unused.invalid' }),
    config,
    ownerId: 'owner',
    paused: () => false,
    token: 'test-token',
  });
  expect(channel.name).toBe('test-telegram');
  expect(channel.adapters).toHaveLength(1);
  expect(channel.adapters[0]?.platform).toBe('telegram');
});
