import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { GoalsPanel } from '../src/client/GoalsPanel';

it('shows a due reminder with progress and a dismiss control', () => {
  const html = renderToStaticMarkup(
    <GoalsPanel
      goals={[
        {
          id: 'goal-1',
          title: 'Prepare a launch brief',
          description: 'Collect final notes',
          status: 'active',
          progress: 62,
          reminderAt: Date.now() - 60_000,
          reminderDismissedAt: null,
          createdAt: Date.now() - 120_000,
          updatedAt: Date.now(),
        },
      ]}
      mutate={vi.fn(async () => true)}
    />,
  );

  expect(html).toContain('Prepare a launch brief');
  expect(html).toContain('Reminder due');
  expect(html).toContain('Dismiss');
  expect(html).toContain('aria-valuenow="62"');
});
