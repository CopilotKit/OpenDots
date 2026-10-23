import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    confirm: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

// A long title used to be a single-line <input>, so it was clipped at the right edge
// instead of wrapping. It is a wrapping textarea now (#68).
it('renders the page title as a wrapping textarea that grows to its content', async () => {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(createElement(PageDocument, props()));
  });
  const titles = tree!.root.findAllByType('textarea' as never);
  const title = titles.find((t) => t.props['aria-label'] === 'Page title');
  expect(title).toBeDefined();
  // rows=1 with height driven from content: one line until the text wraps.
  expect(title!.props.rows).toBe(1);
  expect(title!.props.maxLength).toBe(160);
  expect(
    tree!.root
      .findAllByType('input' as never)
      .some((i) => i.props['aria-label'] === 'Page title'),
  ).toBe(false);
});

it('leaves the title field on Enter without inserting a newline, and keeps it on Shift+Enter', async () => {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(createElement(PageDocument, props()));
  });
  const title = tree!.root
    .findAllByType('textarea' as never)
    .find((t) => t.props['aria-label'] === 'Page title')!;
  const onKeyDown = title.props.onKeyDown as (e: unknown) => void;

  let prevented = false;
  let blurred = false;
  onKeyDown({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
    currentTarget: {
      blur: () => {
        blurred = true;
      },
    },
  });
  expect(prevented).toBe(true);
  expect(blurred).toBe(true);

  prevented = false;
  onKeyDown({
    key: 'Enter',
    shiftKey: true,
    preventDefault: () => {
      prevented = true;
    },
    currentTarget: {
      blur: () => {
        blurred = true;
      },
    },
  });
  expect(prevented).toBe(false);
});
