import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { Config } from '../src/server/research.js';

const stores: Store[] = [];
const workspaces: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const workspace of workspaces.splice(0)) workspace.close();
});

function workspace() {
  const ws = new WorkspaceStore(':memory:', 'owner');
  workspaces.push(ws);
  return ws;
}

function platform(fixture: {
  ws: WorkspaceStore;
  intelligenceKey?: string;
  token?: string;
}) {
  const store = new Store(':memory:');
  stores.push(store);
  const config: Config = { mode: 'live', baseUrl: 'https://example.com' };
  const platform = new Platform(store, fixture.ws, {
    baseUrl: config.baseUrl,
    apiKey: 'fixture',
    model: 'fixture',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    ...(fixture.intelligenceKey
      ? { intelligenceKey: fixture.intelligenceKey }
      : {}),
  });
  const deleteThread = platform.intelligence
    ? vi
        .spyOn(platform.intelligence, 'deleteThread')
        .mockResolvedValue(undefined)
    : vi.fn();
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ...(fixture.token ? { ownerToken: fixture.token } : {}),
  });
  return { store, ws: fixture.ws, platform, app, deleteThread };
}

const remove = (threadId: string) => ({
  url: `/api/threads/${threadId}`,
  init: {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  },
});

describe('WorkspaceStore.deleteThread cascade', () => {
  it('removes the thread binding and every related row while keeping saved pages', () => {
    const ws = workspace();
    const dot = ws.dots()[0];
    ws.bindThread('thread-1', dot.id, 'Research');
    ws.bindThread('thread-2', dot.id, 'Keep me');
    const unrelatedApproval = ws.connections.createApproval({
      threadId: 'thread-2',
      dotId: dot.id,
      connectionId: 'connection-1',
      tool: 'write_note',
      arguments: { text: 'keep this' },
    });
    const taskId = 'task-1';
    ws.bindTask(taskId, 'thread-1');
    ws.createCall('thread-1');
    ws.saveCapture('thread-1', { sample: true, text: 'captured page' });
    const approvalId = ws.connections.createApproval({
      threadId: 'thread-1',
      dotId: dot.id,
      connectionId: 'connection-1',
      tool: 'write_note',
      arguments: { text: 'private note' },
    });
    ws.connections.claimAction(
      'thread-1',
      'tool-call-1',
      approvalId,
      'connection-1',
      'write_note',
    );
    ws.connections.finishAction('thread-1', 'tool-call-1', {
      isError: false,
      text: 'Note saved',
    });
    const page = ws.pages.create(
      dot.spaceId,
      { title: 'Saved page' },
      'thread-1',
    );
    ws.pages.reserveThread(page.id, dot.id, 'thread-1');
    ws.pages.finishThread(page.id, dot.id);
    ws.pages.createReviewed(
      dot.spaceId,
      { title: 'Review', content: 'Reviewed' },
      'thread-1',
      'review-tool-1',
    );

    expect(ws.deleteThread('thread-1')).toBe(true);

    // The conversation itself is gone…
    expect(ws.conversations()).toHaveLength(1);
    expect(ws.requireThread('thread-2').title).toBe('Keep me');
    expect(() => ws.requireThread('thread-1')).toThrow();
    // …along with its tasks, calls, captures and page-chat bindings.
    expect(ws.taskThread(taskId)).toBeUndefined();
    expect(ws.calls()).toHaveLength(0);
    expect(() => ws.calls('thread-1')).toThrow();
    expect(() => ws.capture('thread-1')).toThrow();
    expect(ws.connections.approval(approvalId)).toBeUndefined();
    expect(ws.connections.action('thread-1', 'tool-call-1')).toBeUndefined();
    expect(ws.connections.approval(unrelatedApproval)).toBeDefined();
    expect(ws.pages.forThread('thread-1')).toBeUndefined();
    expect(ws.pages.reviewReceipt('thread-1', 'review-tool-1')).toBeNull();
    // Pages stay as durable artifacts, detached from the dead thread.
    const kept = ws.pages.get(dot.spaceId, page.id);
    expect(kept.sourceThreadId).toBeNull();

    // Retries and unknown ids report that nothing was deleted (idempotent).
    expect(ws.deleteThread('thread-1')).toBe(false);
    expect(ws.deleteThread('missing')).toBe(false);
    expect(ws.conversations()).toHaveLength(1);
  });

  it('leaves unrelated conversations untouched', () => {
    const ws = workspace();
    const dot = ws.dots()[0];
    ws.bindThread('gone', dot.id, 'Gone');
    ws.bindThread('kept', dot.id, 'Kept');
    expect(ws.deleteThread('gone')).toBe(true);
    expect(ws.requireThread('kept').title).toBe('Kept');
  });
});

describe('DELETE /api/threads/:threadId', () => {
  it('deletes the thread on Intelligence and in the workspace, answering 204', async () => {
    const { ws, app, deleteThread } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
    });
    const dot = ws.dots()[0];
    ws.bindThread('to-delete', dot.id, 'Old conversation');
    ws.createCall('to-delete');
    ws.saveCapture('to-delete', { sample: true, text: 'x' });

    const response = await app.request(
      remove('to-delete').url,
      remove('to-delete').init,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(deleteThread).toHaveBeenCalledWith({
      threadId: 'to-delete',
      userId: 'owner',
      agentId: dot.id,
    });
    expect(ws.conversations()).toHaveLength(0);
    expect(ws.calls()).toHaveLength(0);
    expect(() => ws.capture('to-delete')).toThrow();
  });

  it('answers 404 for a thread that was already deleted locally', async () => {
    const { ws, app, deleteThread } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
    });
    ws.bindThread('gone', ws.dots()[0].id, 'Gone');
    expect(
      (await app.request(remove('gone').url, remove('gone').init)).status,
    ).toBe(204);
    deleteThread.mockRejectedValueOnce(
      Object.assign(new Error('Platform 404'), { status: 404 }),
    );
    expect(
      (await app.request(remove('gone').url, remove('gone').init)).status,
    ).toBe(404);
    expect(deleteThread).toHaveBeenCalledTimes(1);
  });

  it('makes concurrent duplicate deletes idempotent', async () => {
    const { ws, app, deleteThread } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
    });
    const dot = ws.dots()[0];
    ws.bindThread('raced', dot.id, 'Raced');
    // The first caller removes the thread on the platform; the racing second
    // caller finds it already gone (platform 404) and still finishes locally.
    deleteThread
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('Platform 404'), { status: 404 }),
      );
    const [first, second] = await Promise.all([
      app.request(remove('raced').url, remove('raced').init),
      app.request(remove('raced').url, remove('raced').init),
    ]);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(ws.conversations()).toHaveLength(0);
    expect(() => ws.requireThread('raced')).toThrow();
    expect(deleteThread).toHaveBeenCalledTimes(2);
    expect(deleteThread).toHaveBeenCalledWith({
      threadId: 'raced',
      userId: 'owner',
      agentId: dot.id,
    });
  });

  it('answers 404 for an unknown thread without contacting the platform', async () => {
    const { ws, app, deleteThread } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
    });
    const response = await app.request(
      remove('missing').url,
      remove('missing').init,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Conversation does not belong to this Dot and owner.',
    });
    expect(deleteThread).not.toHaveBeenCalled();
    expect(ws.conversations()).toHaveLength(0);
  });

  it('requires the owner token, and rejects a wrong token', async () => {
    const { ws, app } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
      token: 'owner-secret',
    });
    ws.bindThread('private', ws.dots()[0].id, 'Private');
    expect(
      (await app.request('/api/threads/private', { method: 'DELETE' })).status,
    ).toBe(401);
    expect(
      (
        await app.request('/api/threads/private', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer wrong-token' },
        })
      ).status,
    ).toBe(401);
    expect(ws.requireThread('private')).toBeDefined();
    expect(
      (
        await app.request('/api/threads/private', {
          method: 'DELETE',
          headers: {
            Authorization: 'Bearer owner-secret',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(204);
    expect(ws.conversations()).toHaveLength(0);
  });

  it('refuses deletion while conversation setup is incomplete', async () => {
    const { ws, app } = platform({ ws: workspace() });
    ws.bindThread('held', ws.dots()[0].id, 'Held');
    const response = await app.request(remove('held').url, remove('held').init);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Setup required/,
    );
    expect(ws.requireThread('held')).toBeDefined();
  });

  it('keeps the local conversation when the platform delete fails for another reason', async () => {
    const { ws, app, deleteThread } = platform({
      ws: workspace(),
      intelligenceKey: 'fixture',
    });
    const dot = ws.dots()[0];
    ws.bindThread('sticky', dot.id, 'Keep me');
    ws.createCall('sticky');
    deleteThread.mockRejectedValueOnce(new Error('Provider secret'));
    const response = await app.request(
      remove('sticky').url,
      remove('sticky').init,
    );
    expect(response.status).toBe(503);
    expect(ws.requireThread('sticky')).toBeDefined();
    expect(ws.calls()).toHaveLength(1);
    expect(ws.conversations()).toHaveLength(1);
  });
});
