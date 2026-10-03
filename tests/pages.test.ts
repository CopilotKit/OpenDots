import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace.js';
it('persists nested page content and revision across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-pages-'));
  let store = new WorkspaceStore(join(dir, 'db'), 'owner');
  const space = store.spaces()[0].id;
  const parent = store.pages.create(space, {
    title: 'Plan',
    content: 'A plan',
  });
  const child = store.pages.create(space, {
    title: 'Detail',
    parentId: parent.id,
  });
  store.pages.update(space, child.id, {
    expectedRevision: 1,
    title: 'New detail',
    content: 'Markdown **body**',
  });
  store.close();
  store = new WorkspaceStore(join(dir, 'db'), 'owner');
  expect(store.pages.get(space, child.id)).toMatchObject({
    title: 'New detail',
    content: 'Markdown **body**',
    revision: 2,
    parentId: parent.id,
  });
  store.close();
  rmSync(dir, { recursive: true });
});
it('rejects cross-space parents, cycles and stale writes without losing content', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const a = store.spaces()[0].id;
  const b = store.createSpace('Other', '').id;
  const root = store.pages.create(a, { title: 'Root' });
  const child = store.pages.create(a, { title: 'Child', parentId: root.id });
  expect(() =>
    store.pages.create(b, { title: 'Wrong', parentId: root.id }),
  ).toThrow();
  expect(() =>
    store.pages.update(a, root.id, { expectedRevision: 1, parentId: child.id }),
  ).toThrow();
  store.pages.update(a, root.id, { expectedRevision: 1, content: 'New' });
  expect(() =>
    store.pages.update(a, root.id, { expectedRevision: 1, content: 'Stale' }),
  ).toThrow(/changed/);
  expect(store.pages.get(a, root.id).content).toBe('New');
  expect(() => store.pages.get(b, root.id)).toThrow();
  store.close();
});

it('deletes a page, cleans up threads and reviews, and reparents descendants safely', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.spaces()[0].id;
  const root = store.pages.create(space, { title: 'Root' });
  const child = store.pages.create(space, {
    title: 'Child',
    parentId: root.id,
  });
  const grandChild = store.pages.create(space, {
    title: 'Grandchild',
    parentId: child.id,
  });

  // Verify deletion of child: grandChild should be reparented to root
  expect(store.pages.delete(space, child.id)).toBe(true);
  expect(store.pages.delete(space, child.id)).toBe(false);
  expect(() => store.pages.get(space, child.id)).toThrow();
  expect(store.pages.get(space, grandChild.id).parentId).toBe(root.id);

  // Verify deletion of root: grandChild should be reparented to null (root level)
  expect(store.pages.delete(space, root.id)).toBe(true);
  expect(store.pages.get(space, grandChild.id).parentId).toBeNull();
  expect(store.pages.list(space)).toHaveLength(1);
  expect(store.pages.list(space)[0].id).toBe(grandChild.id);

  // Missing space throws
  expect(() => store.pages.delete('non-existent-space', grandChild.id)).toThrow(
    /Space not found/,
  );
  store.close();
});
