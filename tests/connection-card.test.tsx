import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionActionCard } from '../src/client/ConnectionActionCard';
it('shows the proposed action and its arguments before anything runs', () => {
  const html = renderToStaticMarkup(
    <ConnectionActionCard
      args={{
        tool: 'mail__send_mail',
        arguments: { to: 'a@example.com', body: { lines: ['Hi'] } },
        summary: 'Email the launch notes to Avery.',
      }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
    />,
  );
  expect(html).toContain('Email the launch notes to Avery.');
  expect(html).toContain('a@example.com');
  expect(html).toContain('mail__send_mail');
  expect(html).toContain('Checking');
  // Decisions wait until the server confirms the action has not already run.
  expect(html).not.toContain('Approve &amp; run');
});
