import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
const menu = vi.hoisted(() => ({
  items: [] as { label: string; action: () => unknown }[],
}));
vi.mock('../src/client/api', () => ({ api }));
vi.mock('../src/client/editor/DocumentMenu', () => ({
  DocumentMenu: ({ items }: { items: typeof menu.items }) => {
    menu.items = items;
    return null;
  },
}));
vi.mock('../src/client/editor/RichEditor', () => ({ default: () => null }));
vi.mock('../src/client/PageConversation', () => ({
  PageConversation: () => null,
}));
import { PageDocument } from '../src/client/PageDocument';

const page = {
  id: 'a',
  spaceId: 'space',
  parentId: null,
  title: 'A',
  content: 'text',
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  sourceThreadId: null,
};
const props = () => ({
  page,
  pages: [page],
  workspace: {} as never,
  paused: false,
  onHome: vi.fn(),
  onOutline: vi.fn(),
  onSubpage: vi.fn(),
  onDirty: vi.fn(),
  onSaved: vi.fn(),
  onRefresh: vi.fn(),
  onDeleted: vi.fn(),
  onSchedule: vi.fn(),
  onThread: vi.fn(),
  onSettings: vi.fn(),
  onCreateDot: vi.fn(),
});
const deletion = () =>
  menu.items.find((item) => item.label === 'Delete page')!.action;

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    confirm: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

it('leaves the page after its deletion finishes while it is still open', async () => {
  const p = props();
  api.mockResolvedValue({ ok: true });
  await act(async () => {
    create(createElement(PageDocument, p));
  });
  await act(async () => {
    await deletion()();
  });
  expect(p.onDeleted).toHaveBeenCalledWith('a');
  expect(p.onRefresh).toHaveBeenCalledTimes(1);
  expect(p.onHome).toHaveBeenCalledTimes(1);
});

it('ignores a stale deletion that finishes after the user left the page', async () => {
  const p = props();
  let finish!: (value: unknown) => void;
  api.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(PageDocument, p));
  });
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = Promise.resolve(deletion()());
  });
  await act(async () => {
    root.unmount();
  });
  const dirtyCalls = p.onDirty.mock.calls.length;
  await act(async () => {
    finish({ ok: true });
    await pending;
  });
  expect(p.onDeleted).toHaveBeenCalledWith('a');
  expect(p.onRefresh).toHaveBeenCalledTimes(1);
  expect(p.onHome).not.toHaveBeenCalled();
  expect(p.onDirty.mock.calls.length).toBe(dirtyCalls);
});
