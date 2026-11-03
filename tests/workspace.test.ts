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

it('deletes one Dot and its private records while preserving shared workspace data', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const remaining = store.dots()[0];
  const target = store.createDot(
    remaining.spaceId,
    'Researcher',
    'Research carefully',
    true,
    true,
  );
  const targetThread = store.bindThread('target-thread', target.id, 'Research');
  const remainingThread = store.bindThread(
    'remaining-thread',
    remaining.id,
    'Keep this',
  );
  const page = store.pages.create(
    remaining.spaceId,
    { title: 'Shared page', content: 'Keep this content' },
    targetThread.id,
  );
  store.pages.reserveThread(page.id, target.id, targetThread.id);
  store.pages.finishThread(page.id, target.id);
  store.createCall(targetThread.id);
  const endedCall = store.calls(targetThread.id)[0];
  store.setCall(endedCall.id, 'ended', 'Call transcript');
  store.bindTask('target-task', targetThread.id);
  store.bindTask('remaining-task', remainingThread.id);
  store.connections.create(
    target.id,
    { name: 'Private connection', url: 'https://example.com/mcp' },
    [],
  );
  store.computers.patch(target.id, { enabled: true });

  const deleted = store.deleteDot(target.id);

  expect(deleted).toEqual({
    threadIds: ['target-thread'],
    taskIds: ['target-task'],
  });
  expect(store.dot(target.id)).toBeUndefined();
  expect(store.dots()).toHaveLength(1);
  expect(store.conversations().map((thread) => thread.id)).toEqual([
    'remaining-thread',
  ]);
  expect(store.taskThread('target-task')).toBeUndefined();
  expect(store.taskThread('remaining-task')).toBe('remaining-thread');
  expect(store.calls()).toEqual([]);
  expect(store.connections.list(target.id)).toEqual([]);
  expect(store.computers.permissions(target.id)).toEqual({
    enabled: false,
    browser: false,
    files: false,
    shell: false,
  });
  expect(store.spaces()).toHaveLength(1);
  expect(store.pages.list(remaining.spaceId)).toContainEqual(
    expect.objectContaining({ id: page.id, content: 'Keep this content' }),
  );
  store.close();
});

it('reports active call, tool, and computer work as deletion blockers', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const [remaining] = store.dots();
  const dot = store.createDot(remaining.spaceId, 'Busy', 'Working', true, true);
  const thread = store.bindThread('busy-thread', dot.id, 'Work');
  const call = store.createCall(thread.id);
  expect(store.dotDeletionBlocker(dot.id)).toMatch(/active call/);
  store.setCall(call.id, 'ended', '');
  const endDotRun = store.trackDotRun(dot.id);
  expect(store.dotDeletionBlocker(dot.id)).toMatch(/active conversation turn/);
  endDotRun();

  const connection = store.connections.create(
    dot.id,
    { name: 'Tools', url: 'https://example.com/mcp' },
    [],
  );
  const approvalId = store.connections.createApproval({
    threadId: thread.id,
    dotId: dot.id,
    connectionId: connection.id,
    tool: 'send_message',
    arguments: {},
  });
  store.connections.claimAction(
    thread.id,
    'tool-call',
    approvalId,
    connection.id,
    'send_message',
  );
  expect(store.dotDeletionBlocker(dot.id)).toMatch(/tool action/);

  store.connections.finishAction('busy-thread', 'tool-call', {
    isError: false,
    text: 'Done',
  });
  const auditId = store.computers.begin(dot.id, 'click', 'agent');
  expect(store.dotDeletionBlocker(dot.id)).toMatch(/computer action/);
  store.computers.finish(auditId, 'succeeded');
  expect(store.dotDeletionBlocker(dot.id)).toBeUndefined();
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
