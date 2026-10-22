import { expect, it } from 'vitest';
import { teamToolEvidence } from '../src/server/team-execution.js';

it('shares actual tool receipts without repeating board summaries or assuming narrated work ran', () => {
  const receipts = teamToolEvidence([
    {
      id: 'plan',
      role: 'assistant',
      content: 'I executed a directory listing.',
    },
    {
      id: 'calls',
      role: 'assistant',
      toolCalls: [
        {
          id: 'read',
          type: 'function',
          function: { name: 'read_team_board', arguments: '{}' },
        },
        {
          id: 'files',
          type: 'function',
          function: { name: 'localtools__list_directory', arguments: '{}' },
        },
      ],
    },
    {
      id: 'board',
      role: 'tool',
      toolCallId: 'read',
      content: 'Duplicated narrative',
    },
    {
      id: 'output',
      role: 'tool',
      toolCallId: 'files',
      content: '{"error":"Permission denied"}',
    },
  ]);
  expect(receipts).toBe(
    'localtools__list_directory: {"error":"Permission denied"}',
  );
  expect(
    teamToolEvidence([
      { id: 'claim', role: 'assistant', content: 'Tests passed' },
    ]),
  ).toBe('');
});
