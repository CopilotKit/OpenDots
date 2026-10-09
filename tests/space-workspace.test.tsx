import { createElement, useEffect, useState, type ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from '../src/server/pages';
const api = vi.hoisted(() => vi.fn());
const unmount = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
vi.mock('../src/client/SpaceLibrary', () => ({
  SpaceLibrary: () => null,
}));
vi.mock('../src/client/PageOutline', () => ({ PageOutline: () => null }));
vi.mock('../src/client/PageDocument', () => ({
  PageDocument: () => {
    const [draft, setDraft] = useState('Unsaved draft');
    useEffect(() => () => unmount(), []);
    return createElement('input', {
      'aria-label': 'Fixture draft',
      value: draft,
      onChange: (event: { target: { value: string } }) =>
        setDraft(event.target.value),
    });
  },
}));
import { SpaceWorkspace } from '../src/client/SpaceWorkspace';
import { SpaceLibrary } from '../src/client/SpaceLibrary';
import { PageDocument } from '../src/client/PageDocument';

const space = { id: 'space', name: 'Space', description: '', createdAt: 0 };
const base: Page = {
  id: 'parent',
  spaceId: space.id,
  parentId: null,
  title: 'Parent',
  content: '',
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  sourceThreadId: null,
};
const child: Page = { ...base, id: 'child', parentId: base.id, title: 'Child' };
const props = (pageId?: string): ComponentProps<typeof SpaceWorkspace> => ({
  space,
  pageId,
  workspace: {
    spaces: [space],
    dots: [],
    conversations: [],
    calls: [],
    setup: {
      intelligence: false,
      model: false,
      browser: false,
      voice: false,
      slack: 'not_configured',
      missing: [],
    },
  },
  paused: false,
  onPage: vi.fn(),
  onDirty: vi.fn(),
  onRefresh: vi.fn(),
  onSchedule: vi.fn(),
  onThread: vi.fn(),
  onSettings: vi.fn(),
  onCreateDot: vi.fn(),
});
const roots: ReactTestRenderer[] = [];
async function mount(p = props()) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(SpaceWorkspace, p));
  });
  roots.push(root);
  return root;
}
const listed = (root: ReactTestRenderer): Page[] =>
  root.root.findByType(SpaceLibrary).props.pages;
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
}
function deferred() {
  let resolve!: (pages: Page[]) => void;
  const promise = new Promise<Page[]>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mockReset().mockResolvedValue([base, child]);
  unmount.mockReset();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('removes externally deleted pages and accepts reparented children on a fresh poll', async () => {
  const root = await mount();
  expect(listed(root)).toEqual([base, child]);
  const reparented = { ...child, parentId: null, revision: 2 };
  api.mockResolvedValueOnce([reparented]);
  await poll();
  expect(listed(root)).toEqual([reparented]);
});

it('retains an open document and its draft, warns about deletion, then drops it on return to the library', async () => {
  const p = props(base.id);
  const root = await mount(p);
  await act(async () => {
    root.root.findByType('input').props.onChange({
      target: { value: 'Keep this edited draft' },
    });
  });
  api.mockResolvedValue([child]);
  await poll();
  expect(root.root.findByType('input').props.value).toBe(
    'Keep this edited draft',
  );
  expect(unmount).not.toHaveBeenCalled();
  expect(root.root.findByProps({ role: 'alert' }).props.children).toContain(
    'deleted elsewhere',
  );
  await act(async () => {
    root.update(createElement(SpaceWorkspace, { ...p, pageId: undefined }));
  });
  await poll();
  expect(listed(root)).toEqual([child]);
});

it('keeps a newly created page against an older poll without keeping it forever', async () => {
  const p = props();
  const root = await mount(p);
  const older = deferred();
  api.mockReturnValueOnce(older.promise);
  await poll();
  const created = { ...base, id: 'new-page' };
  api.mockResolvedValueOnce(created);
  await act(async () => {
    root.root.findByType(SpaceLibrary).props.onNew();
  });
  expect(p.onPage).toHaveBeenCalledWith(created.id);
  await act(async () => older.resolve([base, child]));
  expect(listed(root)).toContainEqual(created);
  api.mockResolvedValueOnce([base, child, created]);
  await poll();
  expect(listed(root)).toContainEqual(created);
  await poll();
  expect(listed(root)).toEqual([base, child]);
});

it('does not overlap list polls while the previous response is pending', async () => {
  const pending = deferred();
  api.mockReturnValueOnce(pending.promise);
  const root = await mount();
  await poll();
  await poll();
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve([base]));
  expect(listed(root)).toEqual([base]);
  await poll();
  expect(api).toHaveBeenCalledTimes(2);
});

it('preserves pages on poll failure and reconciles deletions when polling recovers', async () => {
  const root = await mount();
  api.mockRejectedValueOnce(new Error('Temporary outage.'));
  await poll();
  expect(listed(root)).toEqual([base, child]);
  expect(root.root.findByProps({ role: 'alert' }).props.children).toBe(
    'Temporary outage.',
  );
  api.mockResolvedValueOnce([]);
  await poll();
  expect(listed(root)).toEqual([]);
  expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
});

it('keeps a newer local revision when an earlier poll arrives after a save', async () => {
  const root = await mount(props(base.id));
  const older = deferred();
  api.mockReturnValueOnce(older.promise);
  await poll();
  const saved = { ...base, revision: 3, content: 'Saved locally' };
  await act(async () => {
    root.root.findByType(PageDocument).props.onSaved(saved);
  });
  await act(async () => older.resolve([base, child]));
  expect(root.root.findByType(PageDocument).props.page).toEqual(saved);
});

it('aborts and ignores an old list response after changing the selected page', async () => {
  const p = props();
  const root = await mount(p);
  const older = deferred();
  api.mockReturnValueOnce(older.promise);
  await poll();
  const signal = api.mock.calls[1][3] as AbortSignal;
  await act(async () => {
    root.update(createElement(SpaceWorkspace, { ...p, pageId: base.id }));
  });
  expect(signal.aborted).toBe(true);
  await act(async () => older.resolve([]));
  expect(root.root.findByType(PageDocument).props.page).toEqual(base);
  expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
});

it('bounds a stalled poll and resumes polling after its timeout', async () => {
  const root = await mount();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Fixture timeout.')), ms);
    return controller.signal;
  });
  api.mockImplementationOnce(
    (_path, _method, _body, signal: AbortSignal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  await poll();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(api).toHaveBeenCalledTimes(2);
  expect(listed(root)).toEqual([base, child]);
  expect(root.root.findByProps({ role: 'alert' }).props.children).toBe(
    'Fixture timeout.',
  );
  api.mockResolvedValueOnce([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(api).toHaveBeenCalledTimes(3);
  expect(listed(root)).toEqual([]);
});

it('aborts the list request on unmount', async () => {
  const pending = deferred();
  api.mockReturnValueOnce(pending.promise);
  const root = await mount();
  const signal = api.mock.calls[0][3] as AbortSignal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve([base]));
  expect(root.toJSON()).toBeNull();
});
