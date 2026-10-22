import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
it('persists spaces, specialist permissions, and canonical thread ownership', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  store.bindThread('thread-1', dot.id, 'Design research');
  expect(store.requireThread('thread-1', dot.id).ownerId).toBe('owner');
  expect(() => store.requireThread('thread-1', 'another-dot')).toThrow();
  expect(() => store.requireThread('unknown')).toThrow();
  expect(store.dot(dot.id)?.researchAllowed).toBe(false);
  store.close();
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  expect(() => store.createDot('missing', 'Dot', 'Help', true, true)).toThrow();
  const dots = store.dots();
  store.bindThread('one', dots[0].id, 'First');
  expect(() => store.bindThread('one', dots[0].id, 'Second')).toThrow();
  store.close();
});

it('migrates legacy Space ownership once and never restores revoked access on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-access-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('old', 'Original', '', 1), ('new', 'New', '', 2);
      INSERT INTO dots VALUES ('dot', 'old', 'Dot', 'Help', 1, 1, 1);`);
    legacy.close();
    const ws = new WorkspaceStore(path, 'owner');
    const dot = ws.dot('dot')!;
    expect(dot.spaceIds).toEqual(['old']);
    expect(ws.canAccessSpace('dot', 'new')).toBe(false);
    expect(() =>
      ws.updateDot('dot', { ...dot, spaceIds: ['missing'] }),
    ).toThrow();
    expect(ws.dot('dot')?.spaceIds).toEqual(['old']);
    ws.bindThread('existing-thread', 'dot', 'Keep me');
    ws.updateDot('dot', { ...dot, spaceId: 'new', spaceIds: ['new'] });
    ws.close();
    const reopened = new WorkspaceStore(path, 'owner');
    expect(reopened.dot('dot')?.spaceIds).toEqual(['new']);
    expect(reopened.canAccessSpace('dot', 'old')).toBe(false);
    expect(reopened.requireThread('existing-thread').dotId).toBe('dot');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('unbinds a deleted conversation so it leaves the chat list', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const dot = store.dots()[0];
  store.bindThread('keep', dot.id, 'Keep');
  store.bindThread('gone', dot.id, 'Gone');
  store.unbindThread('gone');
  expect(store.conversations().map((thread) => thread.id)).toEqual(['keep']);
  expect(() => store.requireThread('gone')).toThrow();
  store.close();
});
