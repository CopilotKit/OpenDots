import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { ConnectionActionCard } from '../src/client/ConnectionActionCard';
it('shows the summary and waits for the server record before deciding', () => {
  const html = renderToStaticMarkup(
    <ConnectionActionCard
      args={{
        approvalId: 'approval-1',
        summary: 'Email the launch notes to Avery.',
      }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
    />,
  );
  expect(html).toContain('Email the launch notes to Avery.');
  expect(html).toContain('Checking');
  // Decisions wait until the server confirms the action has not already run.
  expect(html).not.toContain('Approve &amp; run');
});
