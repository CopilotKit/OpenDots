import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { ConnectionActionCard } from '../src/client/ConnectionActionCard';

const text = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object' && 'children' in node
        ? text((node as { children: unknown }).children)
        : '';

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

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

it('offers an explicit retry when the server marks a claim interrupted', async () => {
  api.mockImplementation(async (path: string) =>
    path.includes('/connection-approvals/')
      ? {
          id: 'approval-1',
          connection: 'Mail',
          title: 'send mail!',
          description: 'Send an email.',
          arguments: { to: 'a@example.com', body: 'Hi' },
          expiresAt: Date.now() + 60_000,
        }
      : { approvalId: 'approval-1', status: 'interrupted', result: null },
  );
  const respond = vi.fn(async () => {});
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ConnectionActionCard, {
        args: { approvalId: 'approval-1', summary: 'Send an email.' },
        status: 'executing',
        respond,
        threadId: 'thread',
        toolCallId: 'call',
      }),
    );
  });
  const view = text(root.toJSON());
  expect(view).toContain('Interrupted');
  expect(view).toContain('No result was saved for the previous run.');
  expect(view).toContain('Retrying can repeat the action');
  const retry = root.root.findAll(
    (node) =>
      node.type === 'button' && text(node.props.children) === 'Retry & run',
  )[0];
  expect(retry.props.disabled).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
