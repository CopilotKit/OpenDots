import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
it('migrates review receipts and retains their original draft after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-reviews-'));
  const path = join(dir, 'db');
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'CREATE TABLE page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(threadId,toolCallId))',
  );
  legacy.close();
  let store = new WorkspaceStore(path, 'owner');
  const space = store.spaces()[0].id;
  store.pages.createReviewed(
    space,
    { title: 'Original', content: 'Reviewed content' },
    'thread',
    'call',
  );
  const olderPage = store.pages.create(space, {
    title: 'Earlier approval',
    content: 'Earlier draft',
  });
  store.close();
  const oldReceipt = new DatabaseSync(path);
  oldReceipt
    .prepare(
      'INSERT INTO page_reviews (threadId,toolCallId,pageId,spaceId) VALUES (?,?,?,?)',
    )
    .run('earlier-thread', 'earlier-call', olderPage.id, space);
  oldReceipt.close();
  store = new WorkspaceStore(path, 'owner');
  expect(store.pages.reviewReceipt('thread', 'call')?.draft).toMatchObject({
    title: 'Original',
    content: 'Reviewed content',
    spaceId: space,
  });
  expect(() =>
    store.pages.createReviewed(
      space,
      { title: 'Changed', content: 'Reviewed content' },
      'thread',
      'call',
    ),
  ).toThrow('different draft');
  expect(
    store.pages.reviewReceipt('earlier-thread', 'earlier-call')?.draft,
  ).toBeNull();
  expect(
    store.pages.createReviewed(
      space,
      { title: 'Earlier approval', content: 'Earlier draft' },
      'earlier-thread',
      'earlier-call',
    ).id,
  ).toBe(olderPage.id);
  store.close();
  rmSync(dir, { recursive: true });
});
it('applies an approved review to the page it names instead of creating a copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-review-update-'));
  const store = new WorkspaceStore(join(dir, 'db'), 'owner');
  const space = store.spaces()[0].id;
  const original = store.pages.create(space, {
    title: 'Plan',
    content: 'First version',
  });
  const before = store.pages.list(space).length;
  const draft = {
    title: 'Plan',
    content: 'Revised version',
    pageId: original.id,
    expectedRevision: original.revision,
  };
  const saved = store.pages.createReviewed(space, draft, 'thread', 'call');
  expect(saved.id).toBe(original.id);
  expect(saved).toMatchObject({ content: 'Revised version', revision: 2 });
  expect(store.pages.list(space)).toHaveLength(before);
  // Replaying the same approval is idempotent and does not bump the revision.
  expect(
    store.pages.createReviewed(space, draft, 'thread', 'call').revision,
  ).toBe(2);
  expect(() =>
    store.pages.createReviewed(
      space,
      { ...draft, content: 'Another draft' },
      'thread',
      'call',
    ),
  ).toThrow('different draft');
  store.close();
  rmSync(dir, { recursive: true });
});
it('refuses to revise a page that changed after the review was drafted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-review-stale-'));
  const store = new WorkspaceStore(join(dir, 'db'), 'owner');
  const space = store.spaces()[0].id;
  const page = store.pages.create(space, { title: 'Plan', content: 'v1' });
  store.pages.update(space, page.id, {
    expectedRevision: 1,
    content: 'edited by the owner',
  });
  expect(() =>
    store.pages.createReviewed(
      space,
      {
        title: 'Plan',
        content: 'stale draft',
        pageId: page.id,
        expectedRevision: 1,
      },
      'thread',
      'call',
    ),
  ).toThrow('This page changed');
  expect(store.pages.get(space, page.id).content).toBe('edited by the owner');
  expect(store.pages.reviewReceipt('thread', 'call')).toBeNull();
  expect(() =>
    store.pages.createReviewed(
      space,
      { title: 'Plan', content: 'no revision', pageId: page.id },
      'thread',
      'call2',
    ),
  ).toThrow('needs the revision');
  store.close();
  rmSync(dir, { recursive: true });
});
it('treats null pageId and expectedRevision from a strict tool call as a new page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-review-null-'));
  const store = new WorkspaceStore(join(dir, 'db'), 'owner');
  const space = store.spaces()[0].id;
  const before = store.pages.list(space).length;
  const saved = store.pages.createReviewed(
    space,
    { title: 'New', content: 'Body', pageId: null, expectedRevision: null },
    'thread',
    'call',
  );
  expect(saved).toMatchObject({ title: 'New', revision: 1 });
  expect(store.pages.list(space)).toHaveLength(before + 1);
  expect(
    store.pages.createReviewed(
      space,
      { title: 'New', content: 'Body', pageId: null, expectedRevision: null },
      'thread',
      'call',
    ).id,
  ).toBe(saved.id);
  store.close();
  rmSync(dir, { recursive: true });
});

it('deletes a page and reparents descendants safely', () => {
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
  // Reparenting bumps the revision so clients holding the old parent resync.
  expect(store.pages.get(space, grandChild.id).revision).toBe(
    grandChild.revision + 1,
  );

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

it('drops page thread bindings on delete and never recreates a page from a retried review', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.spaces()[0].id;
  const page = store.pages.create(space, { title: 'Draft' });
  store.pages.reserveThread(page.id, 'dot', 'thread-1');
  store.pages.finishThread(page.id, 'dot');
  expect(store.pages.thread(page.id, 'dot')).toBeDefined();
  expect(store.pages.delete(space, page.id)).toBe(true);
  expect(store.pages.thread(page.id, 'dot')).toBeUndefined();

  const reviewed = store.pages.createReviewed(
    space,
    { title: 'Reviewed', content: 'Reviewed content' },
    'review-thread',
    'call-1',
  );
  expect(store.pages.delete(space, reviewed.id)).toBe(true);
  expect(store.pages.reviewReceipt('review-thread', 'call-1')).toMatchObject({
    pageId: reviewed.id,
    spaceId: space,
  });
  expect(() =>
    store.pages.createReviewed(
      space,
      { title: 'Reviewed', content: 'Reviewed content' },
      'review-thread',
      'call-1',
    ),
  ).toThrow(/Page not found/);
  expect(store.pages.list(space)).toHaveLength(0);
  store.close();
});
