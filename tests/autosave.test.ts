import { afterEach, expect, it, vi } from 'vitest';
import { PageAutosave, type SavePage } from '../src/client/editor/autosave';
import type { Page } from '../src/server/pages';
const page: Page = {
  id: 'a',
  spaceId: 'space',
  parentId: null,
  title: 'Title',
  content: 'Original',
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  sourceThreadId: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
it('does not serialize or save on initial load or unchanged polling', async () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.receive({ ...page });
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).not.toHaveBeenCalled();
  expect(autosave.getSnapshot().draft?.content).toBe('Original');
  autosave.dispose();
});
it('debounces saves and serializes fresh typing behind the in-flight revision', async () => {
  vi.useFakeTimers();
  const first = deferred<Page>();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockImplementationOnce(async (_id, patch) => ({
      ...page,
      ...patch,
      revision: 3,
    }));
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.edit({ content: 'First' });
  await vi.advanceTimersByTimeAsync(800);
  expect(save).toHaveBeenCalledTimes(1);
  autosave.edit({ content: 'Second' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve({ ...page, content: 'First', revision: 2 });
  await vi.advanceTimersByTimeAsync(800);
  expect(save.mock.calls[1][1]).toMatchObject({
    content: 'Second',
    expectedRevision: 2,
  });
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'saved',
    draft: { content: 'Second' },
  });
  autosave.dispose();
});
it('preserves drafts after failure and requires explicit retry; conflicts freeze automatic saves', async () => {
  vi.useFakeTimers();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockRejectedValueOnce(
      Object.assign(new Error('Changed'), { status: 409 }),
    );
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.edit({ content: 'Keep this' });
  await vi.advanceTimersByTimeAsync(800);
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'error',
    draft: { content: 'Keep this' },
  });
  autosave.edit({ content: 'Keep this too' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(1);
  await autosave.flush(true);
  expect(autosave.getSnapshot().status).toBe('conflict');
  autosave.edit({ content: 'Still kept' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(2);
  expect(autosave.getSnapshot().draft?.content).toBe('Still kept');
  autosave.dispose();
});
it('ignores stale completion after navigation and retains dirty work during remote polling', async () => {
  vi.useFakeTimers();
  const pending = deferred<Page>();
  const autosave = new PageAutosave(() => pending.promise);
  autosave.receive(page);
  autosave.edit({ content: 'Unsaved A' });
  await vi.advanceTimersByTimeAsync(800);
  autosave.receive({ ...page, id: 'b', content: 'Page B' });
  pending.resolve({ ...page, content: 'Unsaved A', revision: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(autosave.getSnapshot().draft?.content).toBe('Page B');
  autosave.edit({ content: 'My B draft' });
  autosave.receive({ ...page, id: 'b', revision: 2, content: 'Other B edit' });
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'conflict',
    draft: { content: 'My B draft' },
    remote: { content: 'Other B edit' },
  });
  autosave.dispose();
});
it('bounds a hung save, preserves the ambiguous draft, and does not retry automatically', async () => {
  vi.useFakeTimers();
  const save = vi.fn<SavePage>(() => new Promise<Page>(() => {}));
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.edit({ content: 'Keep after timeout' });
  await vi.advanceTimersByTimeAsync(10800);
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'error',
    draft: { content: 'Keep after timeout' },
    page: { revision: 1 },
  });
  expect(save.mock.calls[0][2].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(50000);
  expect(save).toHaveBeenCalledTimes(1);
  autosave.dispose();
});
it('keeps navigation guarded when typing reverts to the old content during a save, then flushes the revert', async () => {
  vi.useFakeTimers();
  const first = deferred<Page>();
  const save = vi
    .fn<SavePage>()
    .mockReturnValueOnce(first.promise)
    .mockImplementationOnce(async (_id, patch) => ({
      ...page,
      ...patch,
      revision: 3,
    }));
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.edit({ content: 'Temporary' });
  await vi.advanceTimersByTimeAsync(800);
  autosave.edit({ content: 'Original' });
  expect(autosave.dirty).toBe(true);
  first.resolve({ ...page, content: 'Temporary', revision: 2 });
  await vi.advanceTimersByTimeAsync(800);
  expect(save.mock.calls[1][1]).toMatchObject({
    content: 'Original',
    expectedRevision: 2,
  });
  expect(autosave.getSnapshot().status).toBe('saved');
  autosave.dispose();
});
it('preserves a reverted draft when polling finds a save whose response was lost', async () => {
  vi.useFakeTimers();
  const pending = deferred<Page>();
  const save = vi.fn<SavePage>(() => pending.promise);
  const autosave = new PageAutosave(save);
  autosave.receive(page);
  autosave.edit({ content: 'Temporary' });
  await vi.advanceTimersByTimeAsync(800);
  autosave.edit({ content: 'Original' });
  pending.reject(new Error('Connection lost after the server committed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'error',
    draft: { content: 'Original' },
  });

  autosave.receive({ ...page, content: 'Temporary', revision: 2 });
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'conflict',
    draft: { content: 'Original' },
    remote: { content: 'Temporary', revision: 2 },
  });
  expect(autosave.dirty).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(1);

  autosave.useLatest();
  expect(autosave.getSnapshot()).toMatchObject({
    status: 'saved',
    draft: { content: 'Temporary' },
    page: { revision: 2 },
  });
  expect(autosave.dirty).toBe(false);
  autosave.dispose();
});
