import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { executionReceipt } from '../src/shared/execution-receipt.js';

const calls: Message = {
  id: 'assistant',
  role: 'assistant',
  toolCalls: [
    {
      id: 'one',
      type: 'function',
      function: { name: 'browser_find', arguments: '{}' },
    },
    {
      id: 'two',
      type: 'function',
      function: { name: 'browser_click', arguments: '{}' },
    },
  ],
};

it('distinguishes reported failures and missing results from returned tool calls', () => {
  const receipt = executionReceipt([
    calls,
    {
      id: 'result',
      role: 'tool',
      toolCallId: 'one',
      content: JSON.stringify({ error: 'Element no longer exists' }),
    },
  ]);
  expect(receipt).toContain('1 reported tool errors, 1 missing results');
  expect(receipt).toContain('browser_find: Element no longer exists');
});

it('does not treat a page mentioning errors or an empty search as a tool failure', () => {
  const receipt = executionReceipt([
    calls,
    {
      id: 'one-result',
      role: 'tool',
      toolCallId: 'one',
      content: '{"matches":[]}',
    },
    {
      id: 'two-result',
      role: 'tool',
      toolCallId: 'two',
      content: '{"text":"Error handling documentation"}',
    },
    {
      id: 'old',
      role: 'tool',
      toolCallId: 'unrelated',
      content: '{"error":"Old failure"}',
    },
  ]);
  expect(receipt).toContain('2 results returned, 0 reported tool errors');
  expect(receipt).toContain('does not establish that the task is complete');
  expect(receipt).not.toContain('Old failure');
});

it('does not count narration as execution', () => {
  expect(
    executionReceipt([
      { id: 'claim', role: 'assistant', content: 'I will click now' },
    ]),
  ).toContain('no tools were called');
});

it('shows mapping receipts independently of unsupported assistant claims', () => {
  const start: Message = {
    id: 'start',
    role: 'assistant',
    content: 'Everything is mapped!',
    toolCalls: [
      {
        id: 'teach',
        type: 'function',
        function: { name: 'localtools__browser_teach_start', arguments: '{}' },
      },
    ],
  };
  const receipt = executionReceipt([
    start,
    {
      id: 'result',
      role: 'tool',
      toolCallId: 'teach',
      content: JSON.stringify({ name: 'Menu', status: 'waiting_for_owner' }),
    },
  ]);
  expect(receipt).toContain('Menu: waiting_for_owner — no new save verified');
  expect(receipt).not.toContain('SAVED:');
});

it('only shows a save receipt when finish returned a saved record', () => {
  const finish: Message = {
    id: 'finish',
    role: 'assistant',
    toolCalls: [
      {
        id: 'teach',
        type: 'function',
        function: { name: 'localtools__browser_teach_finish', arguments: '{}' },
      },
    ],
  };
  expect(
    executionReceipt([
      finish,
      {
        id: 'result',
        role: 'tool',
        toolCallId: 'teach',
        content: '{"error":"Session expired"}',
      },
    ]),
  ).toContain('no new save verified');
  expect(
    executionReceipt([
      finish,
      {
        id: 'result',
        role: 'tool',
        toolCallId: 'teach',
        content: '{"id":"saved-id","name":"Menu"}',
      },
    ]),
  ).toContain('SAVED: Menu (ID saved-id)');
});
