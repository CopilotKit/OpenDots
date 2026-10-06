import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { PageReviewCard } from '../src/client/PageReviewCard';

const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
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

it('drops the saved page when a refreshed receipt reports it deleted', async () => {
  const saved = {
    id: 'page',
    spaceId: 'space',
    parentId: null,
    title: 'Brief',
    content: 'Evidence',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    sourceThreadId: null,
    reviewDraft: draft,
  };
  api.mockResolvedValueOnce(saved).mockResolvedValueOnce({
    deleted: true,
    pageId: 'page',
    spaceId: 'space',
    reviewDraft: draft,
  });
  const respond = vi.fn(async () => {});
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(PageReviewCard, {
        args: draft,
        status: 'executing',
        respond,
        threadId: 'thread',
        toolCallId: 'call',
        onSaved: () => {},
      }),
    );
  });
  expect(text(root.toJSON())).toContain('Open page');
  const button = root.root.findAll(
    (node) =>
      node.type === 'button' && text(node.props.children).includes('Continue'),
  )[0];
  await act(async () => {
    await button.props.onClick();
  });
  const view = text(root.toJSON());
  expect(view).toContain('Saved, then deleted');
  expect(view).not.toContain('Open page');
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ approved: true, deleted: true }),
  );
});

const updateDraft = {
  title: 'Brief',
  content: 'Evidence',
  spaceId: 'space',
  pageId: 'page-a',
  expectedRevision: 1,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const buttonWithText = (root: ReturnType<typeof create>, label: string) =>
  root.root.findAll(
    (node) =>
      node.type === 'button' && text(node.props.children).includes(label),
  )[0];

const mountCard = async (
  args: unknown,
  respond?: (result: unknown) => Promise<void>,
) => {
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(PageReviewCard, {
        args,
        status: 'executing',
        respond: respond ?? (async () => {}),
        threadId: 'thread',
        toolCallId: 'call',
        onSaved: () => {},
      }),
    );
  });
  return root;
};

it('keeps an update approval disabled until the target is identified', async () => {
  const page = deferred<unknown>();
  api.mockImplementation((path: string) => {
    if (path === '/conversations/thread/reviewed-page/call')
      return Promise.resolve(null);
    if (path === '/spaces/space/pages/page-a') return page.promise;
    if (path === '/workspace')
      return Promise.resolve({ spaces: [{ id: 'space', name: 'Handbook' }] });
    throw new Error(`unexpected path ${path}`);
  });
  const root = await mountCard(updateDraft);
  let view = text(root.toJSON());
  expect(view).toContain('Identifying the page this would update');
  expect(view).not.toContain('Updates existing page');
  const gated = buttonWithText(root, 'Approve & update page');
  expect(gated.props.disabled).toBe(true);
  // Clicking the gated button reaches no endpoint.
  const callsBefore = api.mock.calls.length;
  await act(async () => {
    await gated.props.onClick();
  });
  expect(api.mock.calls.length).toBe(callsBefore);
  await act(async () => {
    page.resolve({ id: 'page-a', title: 'Onboarding' });
  });
  view = text(root.toJSON());
  expect(view).toContain('Updates existing page "Onboarding" in Handbook.');
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    false,
  );
});

it('exposes a failed target lookup with a retry and keeps approval gated', async () => {
  let attempts = 0;
  api.mockImplementation((path: string) => {
    if (path === '/conversations/thread/reviewed-page/call')
      return Promise.resolve(null);
    if (path === '/spaces/space/pages/page-a') {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('Connection lost'))
        : Promise.resolve({ id: 'page-a', title: 'Onboarding' });
    }
    if (path === '/workspace') return Promise.resolve({ spaces: [] });
    throw new Error(`unexpected path ${path}`);
  });
  const root = await mountCard(updateDraft);
  let view = text(root.toJSON());
  expect(view).toContain('Could not identify the page this would update.');
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    true,
  );
  const retry = buttonWithText(root, 'Retry target lookup');
  expect(retry).toBeDefined();
  await act(async () => {
    await retry.props.onClick();
  });
  view = text(root.toJSON());
  expect(view).toContain('Updates existing page "Onboarding".');
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    false,
  );
});

it('re-gates approval when the target changes while a lookup is pending', async () => {
  const pageA = deferred<unknown>();
  const pageB = deferred<unknown>();
  api.mockImplementation((path: string) => {
    if (path === '/conversations/thread/reviewed-page/call')
      return Promise.resolve(null);
    if (path === '/spaces/space/pages/page-a') return pageA.promise;
    if (path === '/spaces/space/pages/page-b') return pageB.promise;
    if (path === '/workspace') return Promise.resolve({ spaces: [] });
    throw new Error(`unexpected path ${path}`);
  });
  const root = await mountCard(updateDraft);
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    true,
  );
  await act(async () => {
    root.update(
      createElement(PageReviewCard, {
        args: { ...updateDraft, pageId: 'page-b' },
        status: 'executing',
        respond: async () => {},
        threadId: 'thread',
        toolCallId: 'call',
        onSaved: () => {},
      }),
    );
  });
  // The stale lookup for page-a resolving must not ungate the card.
  await act(async () => {
    pageA.resolve({ id: 'page-a', title: 'Onboarding' });
  });
  let view = text(root.toJSON());
  expect(view).toContain('Identifying the page this would update');
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    true,
  );
  await act(async () => {
    pageB.resolve({ id: 'page-b', title: 'Release plan' });
  });
  view = text(root.toJSON());
  expect(view).toContain('Updates existing page "Release plan".');
  expect(buttonWithText(root, 'Approve & update page').props.disabled).toBe(
    false,
  );
});

it('keeps continuing a saved review available while the target lookup is pending', async () => {
  const saved = {
    id: 'page-a',
    spaceId: 'space',
    parentId: null,
    title: 'Brief',
    content: 'Evidence',
    revision: 2,
    createdAt: 0,
    updatedAt: 0,
    sourceThreadId: null,
    reviewDraft: updateDraft,
  };
  const page = deferred<unknown>();
  api.mockImplementation((path: string) => {
    if (path === '/conversations/thread/reviewed-page/call')
      return Promise.resolve(saved);
    if (path === '/spaces/space/pages/page-a') return page.promise;
    if (path === '/workspace') return page.promise;
    throw new Error(`unexpected path ${path}`);
  });
  const root = await mountCard(updateDraft);
  const view = text(root.toJSON());
  expect(view).toContain('Identifying the page this would update');
  expect(view).toContain('Saved to your Space');
  // The saved-receipt continuation stays independent of the target lookup.
  const cont = buttonWithText(root, 'Continue conversation');
  expect(cont.props.disabled).toBeFalsy();
});
