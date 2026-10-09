import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
vi.mock('../src/client/editor/DocumentMenu', () => ({
  DocumentMenu: () => null,
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
const props = {
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
};
let root: ReturnType<typeof create>;
beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    confirm: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it('preserves edits made after confirming Load latest while the read is pending', async () => {
  await act(async () => {
    root = create(createElement(PageDocument, props));
  });
  const title = () => root.root.findByProps({ 'aria-label': 'Page title' });
  await act(async () => {
    title().props.onChange({ target: { value: 'My draft' } });
  });
  await act(async () => {
    root.update(
      createElement(PageDocument, {
        ...props,
        page: { ...page, title: 'Remote A', revision: 2 },
      }),
    );
  });
  let finish!: (value: unknown) => void;
  api.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const load = root.root
    .findAllByType('button')
    .find((b) => b.children.includes('Load latest'))!;
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = load.props.onClick();
  });
  await act(async () => {
    title().props.onChange({
      target: { value: 'Newer draft typed while loading' },
    });
  });
  await act(async () => {
    finish({ ...page, title: 'Remote A', revision: 2 });
    await pending;
  });
  expect(title().props.value).toBe('Newer draft typed while loading');
});

it('loads the latest revision when the confirmed draft stays unchanged', async () => {
  await act(async () => {
    root = create(createElement(PageDocument, props));
  });
  const title = () => root.root.findByProps({ 'aria-label': 'Page title' });
  await act(async () => {
    title().props.onChange({ target: { value: 'My draft' } });
  });
  await act(async () => {
    root.update(
      createElement(PageDocument, {
        ...props,
        page: { ...page, title: 'Remote A', revision: 2 },
      }),
    );
  });
  api.mockResolvedValue({ ...page, title: 'Remote B', revision: 3 });
  const load = root.root
    .findAllByType('button')
    .find((b) => b.children.includes('Load latest'))!;
  await act(async () => {
    await load.props.onClick();
  });
  expect(title().props.value).toBe('Remote B');
});
