import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PageService } from '../src/server/page-service.js';

it('does not bind a conversation when its page is deleted during thread creation', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = ws.dots()[0];
    const page = ws.pages.create(dot.spaceId, { title: 'Temporary' });
    let resolve!: () => void;
    const remote = new Promise<void>((done) => {
      resolve = done;
    });
    const getOrCreateThread = vi.fn(() => remote);
    const service = new PageService(ws, () => ({
      getOrCreateThread,
      getThreadMessages: async () => ({ messages: [] }),
    }));
    const pending = service.conversation(dot.spaceId, page.id, dot.id);
    const outcome = expect(pending).rejects.toThrow(/Page not found/);
    expect(getOrCreateThread).toHaveBeenCalledTimes(1);
    ws.pages.delete(dot.spaceId, page.id);
    resolve();
    await outcome;
    expect(ws.conversations()).toHaveLength(0);
    expect(ws.pages.thread(page.id, dot.id)).toBeUndefined();
    const replacement = ws.pages.create(dot.spaceId, { title: 'Replacement' });
    const thread = await service.conversation(
      dot.spaceId,
      replacement.id,
      dot.id,
    );
    expect(ws.pages.forThread(thread.id)?.id).toBe(replacement.id);
  } finally {
    ws.close();
  }
});
