import { describe, expect, it, vi } from 'vitest';
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
      connection: 'second-brain',
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
    connection: 'second-brain',
    text: 'Check the newsletter every Monday.',
  };
  it('attaches the memory to the latest user message only', () => {
    const messages = user('Wann prüfen wir den Newsletter?');
    const out = withRecall(messages, recalled);
    expect(out[0]).toBe(messages[0]);
    expect(out[2].content).toMatch(
      /^Wann prüfen wir den Newsletter\?\n\n\[Memory looked up/,
    );
    expect(out[2].content).toContain('Check the newsletter every Monday.');
    expect(messages[2].content).toBe('Wann prüfen wir den Newsletter?');
  });
  it('adds a text part to a multi-part message and leaves messages alone without a result', () => {
    const parts = user([{ type: 'text', text: 'hi there' }]);
    expect(withRecall(parts, recalled)[2].content).toHaveLength(2);
    expect(withRecall(parts, null)).toBe(parts);
  });
});
