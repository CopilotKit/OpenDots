import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { firstJson, repairToolArguments } from '../src/server/tool-args.js';

it('repairs doubled or broken tool-call arguments and leaves valid ones alone', () => {
  expect(firstJson('{"a":1}{"a":1}')).toBe('{"a":1}');
  expect(firstJson('{"q":"a } b"}{"q":"a } b"}')).toBe('{"q":"a } b"}');
  expect(firstJson('{}{}')).toBe('{}');
  expect(firstJson('not json')).toBeUndefined();
  const call = (id: string, args: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'tool', arguments: args },
  });
  const messages = [
    { id: 'u', role: 'user', content: 'hi' },
    {
      id: 'a',
      role: 'assistant',
      toolCalls: [
        call('1', '{"x":1}{"x":1}'),
        call('2', '{"ok":true}'),
        call('3', ''),
        call('4', 'garbage'),
      ],
    },
  ] as Message[];
  const [user, assistant] = repairToolArguments(messages) as [
    Message,
    { toolCalls: { function: { arguments: string } }[] },
  ];
  expect(user).toBe(messages[0]);
  expect(assistant.toolCalls.map((c) => c.function.arguments)).toEqual([
    '{"x":1}',
    '{"ok":true}',
    '{}',
    '{}',
  ]);
});

it('fits long conversations into the budget without breaking tool pairs', async () => {
  const { fitHistory, historyBudget } =
    await import('../src/server/tool-args.js');
  const turn = (n: number) =>
    [
      { id: `u${n}`, role: 'user', content: `request ${n}` },
      {
        id: `a${n}`,
        role: 'assistant',
        toolCalls: [
          {
            id: `c${n}`,
            type: 'function',
            function: { name: 't', arguments: '{}' },
          },
        ],
      },
      {
        id: `t${n}`,
        role: 'tool',
        toolCallId: `c${n}`,
        content: 'x'.repeat(5000),
      },
      { id: `r${n}`, role: 'assistant', content: `answer ${n}` },
    ] as Message[];
  const history = Array.from({ length: 30 }, (_, n) => turn(n)).flat();
  const budget = historyBudget(16384, 10000);
  const fitted = fitHistory(history, budget);
  expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(budget + 8000);
  expect(fitted[0].role).toBe('user');
  expect(fitted.at(-1)).toMatchObject({ id: 'r29' });
  // Older tool output is shortened, the most recent stays intact.
  const tools = fitted.filter((m) => m.role === 'tool') as {
    content: string;
  }[];
  expect(tools.at(-1)!.content.length).toBe(5000);
  if (tools.length > 1) expect(tools[0].content).toContain('shortened');
  // A short chat is untouched.
  expect(fitHistory(turn(0), budget)).toHaveLength(4);
});
