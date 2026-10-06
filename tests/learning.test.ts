import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { WorkspaceStore } from '../src/server/workspace.js';
import { learningSelector } from '../src/server/learning.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => ws.close());
  const dot = ws.dots()[0];
  return { ws, dot };
}
const input = (threadId: string): RunAgentInput => ({
  threadId,
  runId: 'run',
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
});

it('freezes container assignments, including disabled conversations, when a Dot changes', () => {
  const { ws, dot } = fixture();
  ws.bindThread('disabled', dot.id, 'Before learning');
  ws.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  ws.bindThread('research', dot.id, 'Research');
  ws.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'writing',
    skillDeliveryEnabled: true,
  });
  ws.bindThread('writing', dot.id, 'Writing');
  expect(ws.requireThread('disabled').learningContainerId).toBeNull();
  expect(ws.requireThread('research').learningContainerId).toBe('research');
  expect(ws.requireThread('writing').learningContainerId).toBe('writing');
  ws.updateDot(dot.id, {
    ...dot,
    learningContainerId: null,
    skillDeliveryEnabled: false,
  });
  expect(ws.requireThread('research').learningContainerId).toBe('research');
});

it('migrates legacy threads without enrolling them and persists configuration across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-learning-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO thread_bindings VALUES ('old', 'dot', 'owner', 'Existing', 1);`);
  legacy.close();
  const ws = new WorkspaceStore(path, 'owner');
  const dot = ws.dots()[0];
  ws.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  ws.bindThread('new', dot.id, 'New');
  ws.close();
  const reopened = new WorkspaceStore(path, 'owner');
  cleanup.push(() => reopened.close());
  expect(reopened.requireThread('old').learningContainerId).toBeNull();
  expect(reopened.requireThread('new').learningContainerId).toBe('research');
  expect(reopened.dot(dot.id)).toMatchObject({
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
});

it('selects only owned web threads and binds the configured channel Dot before its first run', () => {
  const { ws, dot } = fixture();
  ws.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  ws.bindThread('web', dot.id, 'Web');
  const select = learningSelector(ws, dot.id);
  const user = { id: 'owner', name: 'Owner' };
  expect(
    select({ surface: 'web', user, agentId: dot.id, input: input('web') }),
  ).toBe('research');
  expect(() =>
    select({ surface: 'web', user, agentId: dot.id, input: input('unknown') }),
  ).toThrow();
  expect(
    select({
      surface: 'channel',
      user,
      agentId: dot.id,
      input: input('slack'),
    }),
  ).toBe('research');
  expect(ws.requireThread('slack', dot.id).learningContainerId).toBe(
    'research',
  );
  expect(() =>
    select({
      surface: 'channel',
      user: null,
      agentId: dot.id,
      input: input('unauthorized'),
    }),
  ).toThrow();
  expect(() =>
    select({
      surface: 'web',
      user: { id: 'other', name: 'Other' },
      agentId: dot.id,
      input: input('web'),
    }),
  ).toThrow();
  const other = ws.createDot(dot.spaceId, 'Other', 'Other role', true, true);
  expect(() =>
    select({
      surface: 'channel',
      user,
      agentId: other.id,
      input: input('wrong-dot'),
    }),
  ).toThrow();
  expect(() =>
    select({ surface: 'web', user, agentId: other.id, input: input('web') }),
  ).toThrow();
  expect(ws.conversations()).toHaveLength(2);
});

it('rejects invalid container IDs and delivery without a container', () => {
  const { ws, dot } = fixture();
  for (const learningContainerId of [
    '',
    'Upper',
    'two--hyphens',
    '-leading',
    'trailing-',
    'a'.repeat(65),
  ]) {
    expect(() =>
      ws.updateDot(dot.id, { ...dot, learningContainerId }),
    ).toThrow();
  }
  expect(() =>
    ws.updateDot(dot.id, {
      ...dot,
      learningContainerId: null,
      skillDeliveryEnabled: true,
    }),
  ).toThrow();
  expect(ws.dot(dot.id)?.learningContainerId).toBeNull();
});
