import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { ComputerToolCard } from '../src/client/ComputerToolCard';

it('shows real terminal output and does not treat a nonzero exit as success', () => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_exec"
      toolCallId="exec"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      result={JSON.stringify({
        exitCode: 1,
        stdout: '',
        stderr: 'File not found',
      })}
    />,
  );
  expect(html).toContain('Needs attention');
  expect(html).toContain('File not found');
  expect(html).not.toContain('Finished');
});

it('marks unfinished calls interrupted after a run ends and labels live views as current', () => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_navigate"
      toolCallId="nav"
      status="inProgress"
      dotId="scout"
      dotName="Scout"
      showScreen
      running={false}
      args={{ url: 'https://example.com' }}
    />,
  );
  expect(html).toContain('Interrupted');
  expect(html).toContain('Current browser view');
  expect(html).toContain('https://example.com');
  expect(html).not.toContain('<img');
});

it.each([
  [
    {
      status: 'stopped',
      reason: 'stop_requested',
      message: 'The run was stopped.',
    },
    'Interrupted',
  ],
  [
    {
      status: 'error',
      reason: 'missing_terminal_event',
      message: 'The tool never returned.',
    },
    'Needs attention',
  ],
])('recognizes runtime-finalized tool result %j', (result, label) => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_navigate"
      toolCallId="nav"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      result={JSON.stringify(result)}
    />,
  );
  expect(html).toContain(label);
  expect(html).toContain(result.message);
  expect(html).not.toContain('Finished');
});
