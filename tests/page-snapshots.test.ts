import { expect, it } from 'vitest';
import type { Page } from '../src/server/pages';
import { mergePageSnapshot } from '../src/client/page-snapshots';
const base: Page = {
  id: 'existing',
  spaceId: 'space',
  parentId: null,
  title: 'Existing',
  content: '',
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  sourceThreadId: null,
};
it('retains a newly created document when an earlier list response arrives after creation', async () => {
  let resolve!: (pages: Page[]) => void;
  const olderRead = new Promise<Page[]>((done) => {
    resolve = done;
  });
  let pages = [base];
  const created = { ...base, id: 'new-page', title: 'New page' };
  const pending = olderRead.then((snapshot) => {
    pages = mergePageSnapshot(
      pages,
      snapshot,
      new Set(),
      new Set([created.id]),
    );
  });
  pages = [...pages, created];
  const selectedId = created.id;
  resolve([base]);
  await pending;
  expect(pages.find((page) => page.id === selectedId)).toBe(created);
  expect(pages).toHaveLength(2);
});
it('retains locally saved revisions while accepting newer remote pages', () => {
  const local = { ...base, revision: 3, content: 'Saved locally' };
  const remote = { ...base, id: 'remote', content: 'Other page' };
  expect(mergePageSnapshot([local], [base, remote])).toEqual([local, remote]);
  expect(
    mergePageSnapshot([local], [{ ...base, revision: 4, content: 'Latest' }])[0]
      .content,
  ).toBe('Latest');
});

it('ignores a stale poll that still lists a deleted page', () => {
  const gone = { ...base, id: 'gone' };
  expect(mergePageSnapshot([base], [base, gone], new Set(['gone']))).toEqual([
    base,
  ]);
});

it('removes pages absent from a fresh complete snapshot', () => {
  expect(mergePageSnapshot([base], [])).toEqual([]);
});

it('retains an explicitly protected open page but never resurrects a tombstone', () => {
  expect(mergePageSnapshot([base], [], new Set(), new Set([base.id]))).toEqual([
    base,
  ]);
  expect(
    mergePageSnapshot([base], [base], new Set([base.id]), new Set([base.id])),
  ).toEqual([]);
});
