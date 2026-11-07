import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  autoRecall,
  withRecall,
  type RecallSource,
} from '../src/server/auto-recall.js';
import type { ExposedTool } from '../src/server/connections.js';

function tool(
  name: string,
  over: Partial<ExposedTool['tool']> = {},
): ExposedTool {
  return {
    name: `second-brain__${name}`,
    connection: { id: 'c1', name: 'second-brain' } as ExposedTool['connection'],
    tool: {
      name,
      title: name,
      description: '',
      inputSchema: {},
      readOnly: true,
      enabled: true,
      requiresApproval: false,
      ...over,
    } as ExposedTool['tool'],
  };
}
function source(
  tools: ExposedTool[],
  text = 'Check the newsletter every Monday.',
) {
  const call = vi.fn<RecallSource['call']>(async () => ({
    isError: false,
    text,
  }));
  return { source: { tools: () => tools, call } as RecallSource, call };
}
const user = (content: unknown) => [
  { role: 'user', content: 'older question' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content },
];
const signal = new AbortController().signal;

describe('autoRecall', () => {
  it('recalls with the latest user message and returns the result', async () => {
    const { source: s, call } = source([tool('remember'), tool('recall')]);
    const result = await autoRecall(
      s,
      'dot',
      user('Wann prüfen wir den Newsletter?'),
      signal,
    );
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0][0].tool.name).toBe('recall');
    expect(call.mock.calls[0][1]).toEqual({
      query: 'Wann prüfen wir den Newsletter?',
    });
    expect(result).toEqual({
      name: 'second-brain__recall',
      query: 'Wann prüfen wir den Newsletter?',
      text: 'Check the newsletter every Monday.',
    });
  });

  it('reads text parts of a multi-part message', async () => {
    const { source: s, call } = source([tool('recall')]);
    await autoRecall(
      s,
      'dot',
      user([{ type: 'text', text: 'when is the newsletter' }]),
      signal,
    );
    expect(call.mock.calls[0][1]).toEqual({ query: 'when is the newsletter' });
  });

  it('does not call a recall tool the owner put behind approval or the server did not mark read-only', async () => {
    for (const over of [{ requiresApproval: true }, { readOnly: false }]) {
      const { source: s, call } = source([tool('recall', over)]);
      expect(
        await autoRecall(s, 'dot', user('a real question'), signal),
      ).toBeNull();
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('goes on without memory when the server fails or finds nothing', async () => {
    const failing = {
      tools: () => [tool('recall')],
      call: vi.fn(async () => ({ isError: true, text: 'Unauthorized' })),
    } as RecallSource;
    expect(
      await autoRecall(failing, 'dot', user('a real question'), signal),
    ).toBeNull();
    const throwing = {
      tools: () => [tool('recall')],
      call: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as RecallSource;
    expect(
      await autoRecall(throwing, 'dot', user('a real question'), signal),
    ).toBeNull();
    const { source: empty } = source([tool('recall')], '   ');
    expect(
      await autoRecall(empty, 'dot', user('a real question'), signal),
    ).toBeNull();
  });

  it('skips a turn with no usable user text', async () => {
    const { source: s, call } = source([tool('recall')]);
    expect(await autoRecall(s, 'dot', user('ok'), signal)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('withRecall', () => {
  const recalled = {
    name: 'second-brain__recall',
    query: 'Wann prüfen wir den Newsletter?',
    text: 'Check the newsletter every Monday.',
  };
  const messages: Message[] = [
    { id: '1', role: 'user', content: 'older question' },
    { id: '2', role: 'assistant', content: 'older answer' },
    { id: '3', role: 'user', content: 'Wann prüfen wir den Newsletter?' },
  ];
  it('adds the memory as a tool call and result after the latest user message', () => {
    const out = withRecall(messages, recalled);
    expect(out.slice(0, 3)).toEqual(messages);
    expect(out.slice(3)).toEqual([
      {
        id: 'auto-recall-call',
        role: 'assistant',
        toolCalls: [
          {
            id: 'auto-recall',
            type: 'function',
            function: {
              name: 'second-brain__recall',
              arguments: '{"query":"Wann prüfen wir den Newsletter?"}',
            },
          },
        ],
      },
      {
        id: 'auto-recall-result',
        role: 'tool',
        toolCallId: 'auto-recall',
        content: 'Check the newsletter every Monday.',
      },
    ]);
  });
  it('leaves messages alone without a result', () => {
    expect(withRecall(messages, null)).toBe(messages);
  });
});
