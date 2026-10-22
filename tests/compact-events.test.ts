import { expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/client';
import { compactEvents } from '../src/server/local-runner.js';

const event = (type: string, extra: Record<string, unknown>) =>
  ({ type, ...extra }) as unknown as BaseEvent;

it('joins the streamed pieces of each message, keeping everything else in order', () => {
  const events = [
    event('RUN_STARTED', { runId: 'r' }),
    event('REASONING_MESSAGE_CONTENT', { messageId: 'a', delta: 'The ' }),
    event('REASONING_MESSAGE_CONTENT', { messageId: 'a', delta: 'trend' }),
    event('TEXT_MESSAGE_START', { messageId: 'b' }),
    event('TEXT_MESSAGE_CONTENT', { messageId: 'b', delta: 'Selling ' }),
    event('TEXT_MESSAGE_CONTENT', { messageId: 'b', delta: 'now.' }),
    event('TOOL_CALL_ARGS', { toolCallId: 'c', delta: '{"dir' }),
    event('TOOL_CALL_ARGS', { toolCallId: 'c', delta: 'ection":"sell"}' }),
    event('TOOL_CALL_ARGS', { toolCallId: 'd', delta: '{}' }),
    event('TEXT_MESSAGE_CONTENT', { messageId: 'e', delta: 'Next.' }),
    event('RUN_FINISHED', { runId: 'r' }),
  ];
  expect(compactEvents(events)).toEqual([
    event('RUN_STARTED', { runId: 'r' }),
    event('REASONING_MESSAGE_CONTENT', { messageId: 'a', delta: 'The trend' }),
    event('TEXT_MESSAGE_START', { messageId: 'b' }),
    event('TEXT_MESSAGE_CONTENT', { messageId: 'b', delta: 'Selling now.' }),
    event('TOOL_CALL_ARGS', {
      toolCallId: 'c',
      delta: '{"direction":"sell"}',
    }),
    event('TOOL_CALL_ARGS', { toolCallId: 'd', delta: '{}' }),
    event('TEXT_MESSAGE_CONTENT', { messageId: 'e', delta: 'Next.' }),
    event('RUN_FINISHED', { runId: 'r' }),
  ]);
});
