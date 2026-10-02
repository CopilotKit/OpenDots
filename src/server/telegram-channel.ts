import {
  createChannel,
  type ChannelIdentityContext,
  type IncomingMessage,
  type Thread,
} from '@copilotkit/channels';
import { telegram } from '@copilotkit/channels/telegram';
import type { PlatformConfig } from './platform-config.js';

type TelegramConfig = Pick<PlatformConfig, 'telegramUsers'>;
type Report = (operation: string, errors: string[]) => void;

export function telegramIdentity(
  context: ChannelIdentityContext,
  config: TelegramConfig,
  ownerId: string,
) {
  if (
    context.provider !== 'telegram' ||
    context.actor.kind !== 'human' ||
    !config.telegramUsers.includes(context.actor.id)
  )
    return null;
  return { id: ownerId, name: 'OpenDots owner' };
}

type Turn = {
  thread: Pick<Thread, 'runAgent' | 'post'>;
  message: IncomingMessage;
};

const safeErrorName = (error: unknown): string =>
  error instanceof Error &&
  ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
    ? error.name
    : 'Error';

export function telegramHandlers(options: {
  config: TelegramConfig;
  ownerId: string;
  paused: () => boolean;
  report?: Report;
}) {
  const report =
    options.report ??
    ((operation, errors) => {
      console.error(operation + ': ' + errors.join('; '));
    });

  const eligible = ({ message }: Turn) =>
    message.platform === 'telegram' &&
    message.user?.id === options.ownerId &&
    message.actor.kind === 'human' &&
    options.config.telegramUsers.includes(message.actor.id) &&
    (message.operation?.kind ?? 'created') === 'created';

  async function notice(thread: Turn['thread'], text: string) {
    try {
      await thread.post(text);
    } catch (error) {
      const safe = safeErrorName(error);
      report('Telegram notice failed', [safe]);
      throw new Error('Telegram notice failed: ' + safe);
    }
  }

  async function run(thread: Turn['thread']) {
    if (options.paused()) {
      await notice(
        thread,
        'OpenDots is paused. Resume it in the app before asking me to continue.',
      );
      return;
    }
    try {
      await thread.runAgent();
    } catch (error) {
      const runError = safeErrorName(error);
      try {
        await thread.post(
          'I couldn’t complete that request. Please check OpenDots and send a new message when you’re ready to try again.',
        );
      } catch (postError) {
        const replyError = safeErrorName(postError);
        report('Telegram agent run and error reply failed', [
          runError,
          replyError,
        ]);
        throw new AggregateError(
          [new Error('Agent run: ' + runError), new Error('Error reply: ' + replyError)],
          'Telegram agent run and error reply failed',
        );
      }
      report('Telegram agent run failed; error reply posted', [runError]);
    }
  }

  return {
    async mention(turn: Turn) {
      if (eligible(turn)) await run(turn.thread);
    },
    async message(turn: Turn) {
      if (eligible(turn)) await run(turn.thread);
    },
  };
}

export function createTelegramChannel(options: {
  name: string;
  agent: NonNullable<Parameters<typeof createChannel>[0]['agent']>;
  config: TelegramConfig;
  ownerId: string;
  paused: () => boolean;
  token: string;
  mode?: 'polling' | 'webhook' | 'auto';
  webhook?: {
    domain: string;
    path?: string;
    port?: number;
    secretToken?: string;
  };
}) {
  const channel = createChannel({
    name: options.name,
    agent: options.agent,
    identifyUser: (context) =>
      telegramIdentity(context, options.config, options.ownerId),
    adapters: [
      telegram({
        token: options.token,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.webhook ? { webhook: options.webhook } : {}),
      }),
    ],
    store: { concurrency: 'serial' },
  });

  const handlers = telegramHandlers(options);
  channel.onMention(handlers.mention);
  channel.onMessage(handlers.message);
  return channel;
}
