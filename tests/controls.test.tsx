import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TaskActions } from '../src/client/TaskActions';
import type { Settings, Task } from '../src/shared/types';
const settings: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
const task: Task = {
  id: 'one',
  prompt: 'A recurring task',
  status: 'completed',
  intervalSeconds: 3600,
  nextRunAt: Date.now() + 3600000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  error: null,
  lease: null,
  leaseUntil: null,
};
it('offers pause for a completed task waiting on its next scheduled run', () => {
  const html = renderToStaticMarkup(
    <TaskActions
      task={task}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Pause schedule');
  expect(html).toContain('Edit schedule');
});
it('offers resume for a paused task without claiming to be running', () => {
  const html = renderToStaticMarkup(
    <TaskActions
      task={{ ...task, status: 'paused' }}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Resume task');
  expect(html).not.toContain('Pause schedule');
});
