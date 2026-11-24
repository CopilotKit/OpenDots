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

it('lists dots with one batch query for space grants instead of N+1', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const design = store.createSpace('Design', 'Design decisions');
  const research = store.createSpace('Research', 'Research notes');
  const multi = store.createDot(design.id, 'Scout', 'Be concise', true, true, [
    design.id,
    research.id,
  ]);
  const single = store.createDot(
    research.id,
    'Solo',
    'Work alone',
    false,
    false,
    [research.id],
  );
  // A dot with no space grants at all must read back with an empty list.
  const db = (store as unknown as { db: import('node:sqlite').DatabaseSync })
    .db;
  db.prepare(
    'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('lonely', research.id, 'Lonely', 'Hi', 0, 0, 1);

  let prepares = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    prepares++;
    return (prepare as (...args: unknown[]) => unknown)(sql, ...rest);
  }) as typeof db.prepare;

  const dots = store.dots();

  // Two round-trips total (dots + all dot_spaces), regardless of dot count.
  expect(prepares).toBe(2);
  const byId = new Map(dots.map((dot) => [dot.id, dot]));
  expect(byId.get(multi.id)?.spaceIds).toEqual([design.id, research.id].sort());
  expect(byId.get(single.id)?.spaceIds).toEqual([research.id]);
  expect(byId.get('lonely')?.spaceIds).toEqual([]);
  // Unrelated columns keep their coercions.
  expect(byId.get(multi.id)?.researchAllowed).toBe(true);
  expect(byId.get('lonely')?.memoryAllowed).toBe(false);
  store.close();
});
