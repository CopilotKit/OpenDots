import { createElement, StrictMode, type ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
vi.mock('../src/client/Chat', () => ({ Chat: () => null }));
import { PageConversation } from '../src/client/PageConversation';
import { Chat } from '../src/client/Chat';

const dot = {
  id: 'dot-a',
  name: 'Scout',
  spaceId: 'space',
  spaceIds: ['space'],
  instructions: '',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
};
const thread: Conversation = {
  id: 'thread-a',
  dotId: dot.id,
  ownerId: 'owner',
  title: 'Page conversation',
  createdAt: 0,
};
const props = () => ({
  page: {
    id: 'page-a',
    spaceId: 'space',
    parentId: null,
    title: 'Page A',
    content: '',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    sourceThreadId: null,
  },
  workspace: {
    spaces: [],
    dots: [dot],
    conversations: [],
    calls: [],
    setup: {
      intelligence: true,
      model: true,
      browser: false,
      voice: false,
      slack: 'not_configured',
      missing: [],
    },
  },
  paused: false,
  beforeChat: vi.fn(async () => true),
  onRefresh: vi.fn(),
  onSchedule: vi.fn(),
  onSettings: vi.fn(),
  onCreateDot: vi.fn(),
  onOpenChange: vi.fn(),
});
const roots: ReactTestRenderer[] = [];
const view = (p: ComponentProps<typeof PageConversation>, strict = true) =>
  strict
    ? createElement(StrictMode, null, createElement(PageConversation, p))
    : createElement(PageConversation, p);
async function mount(p: ReturnType<typeof props>, strict = true) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(view(p, strict));
  });
  roots.push(root);
  p.onOpenChange.mockClear();
  return root;
}
async function submit(root: ReactTestRenderer, prompt?: string) {
  if (prompt !== undefined)
    await act(async () => {
      root.root.findByType('input').props.onChange({
        target: { value: prompt },
      });
    });
  await act(async () => {
    root.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
}
const sendButton = (root: ReactTestRenderer) =>
  root.root.findByProps({ 'aria-label': 'Send to page assistant' });
function deferred() {
  let resolve!: (value: Conversation) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Conversation>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.mockReset().mockResolvedValue(thread);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'opens page chat on the first empty submit (StrictMode=%s)',
  async (strict) => {
    const p = props();
    const root = await mount(p, strict);
    // Do not type first: an input rerender masks the effect-replay bug.
    await submit(root);
    expect(p.beforeChat).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/spaces/space/pages/page-a/conversation',
      'POST',
      { dotId: dot.id },
    );
    expect(root.root.findByType(Chat).props.thread).toEqual(thread);
    expect(p.onOpenChange).toHaveBeenCalledWith(true);
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  },
);

it.each(['save', 'api'])(
  'releases busy state and permits retry after a %s failure',
  async (failure) => {
    const p = props();
    if (failure === 'save') p.beforeChat.mockResolvedValueOnce(false);
    else api.mockRejectedValueOnce(new Error('Conversation unavailable.'));
    const root = await mount(p);
    await submit(root, 'Explain this page');
    expect(root.root.findByProps({ role: 'alert' }).props.children).toContain(
      failure === 'save' ? 'Save or resolve' : 'Conversation unavailable.',
    );
    expect(api).toHaveBeenCalledTimes(failure === 'save' ? 0 : 1);
    expect(sendButton(root).props.disabled).toBe(false);
    expect(root.root.findByType('input').props.disabled).toBe(false);
    await submit(root);
    expect(root.root.findByType(Chat).props.initialPrompt).toBe(
      'Explain this page',
    );
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['page', 'success'],
  ['page', 'error'],
  ['dot', 'success'],
  ['dot', 'error'],
])(
  'ignores an old %s chat %s without settling a newer request',
  async (change, outcome) => {
    const p = props();
    const old = deferred(),
      latest = deferred();
    api.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const root = await mount(p);
    await submit(root, 'Explain this page');
    expect(api).toHaveBeenCalledTimes(1);
    const next = {
      ...p,
      ...(change === 'page'
        ? { page: { ...p.page, id: 'page-b' } }
        : { workspace: { ...p.workspace, dots: [{ ...dot, id: 'dot-b' }] } }),
    };
    await act(async () => root.update(view(next)));
    await submit(root);
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === 'success') old.resolve(thread);
      else old.reject(new Error('Stale failure.'));
    });
    expect(p.onRefresh).not.toHaveBeenCalled();
    expect(p.onOpenChange).not.toHaveBeenCalledWith(true);
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(sendButton(root).props.disabled).toBe(true);
    const nextThread = {
      ...thread,
      id: 'thread-b',
      dotId: next.workspace.dots[0].id,
    };
    await act(async () => latest.resolve(nextThread));
    expect(root.root.findByType(Chat).props.thread).toEqual(nextThread);
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  },
);

it.each(['success', 'error'])(
  'ignores a chat %s that arrives after unmount',
  async (outcome) => {
    const p = props();
    const pending = deferred();
    api.mockReturnValueOnce(pending.promise);
    const root = await mount(p);
    await submit(root, 'Explain this page');
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    p.onOpenChange.mockClear();
    await act(async () => {
      if (outcome === 'success') pending.resolve(thread);
      else pending.reject(new Error('Stale failure.'));
    });
    expect(p.onRefresh).not.toHaveBeenCalled();
    expect(p.onOpenChange).not.toHaveBeenCalled();
  },
);
