import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamBoardService, TeamBoardStore } from '../src/server/team-board.js';
import { teamBoardRoutes } from '../src/server/team-board-routes.js';

const input = {
  objective: 'Compare the options and choose one',
  participants: ['lead', 'research'],
  leadId: 'lead',
  rounds: 2,
};

describe('team board', () => {
  it('uses owner corrections on subsequent turns, including a correction during the final turn', async () => {
    const store = new TeamBoardStore(':memory:');
    let turns = 0;
    const service = new TeamBoardService(
      store,
      async (board, _dot, prompt) => {
        turns++;
        if (turns === 1)
          service.steer(
            board.id,
            'Inspect src/client only; report tool evidence.',
          );
        else expect(prompt).toContain('Inspect src/client only');
        if (turns === 2)
          service.steer(
            board.id,
            'Inspect src/client only; test cancellation too.',
          );
        if (turns > 2) expect(prompt).toContain('test cancellation too');
        return 'New finding';
      },
      () => {},
    );
    const board = service.create({ ...input, rounds: 1 });
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('decided'));
    expect(turns).toBe(4);
    expect(store.get(board.id).rounds).toBe(2);
    expect(() => service.steer(board.id, 'Too late')).toThrow(/running/);
    await service.shutdown();
  });

  it('does not report a successful improvement based on an agent claiming it submitted code', async () => {
    const store = new TeamBoardStore(':memory:');
    const service = new TeamBoardService(
      store,
      async () => 'I fixed it and all tests passed.',
      () => {},
    );
    const board = service.create({
      ...input,
      mode: 'improvement',
      developerId: 'research',
      rounds: 1,
    });
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('blocked'));
    expect(store.get(board.id).error).toContain('No tested code change');
    await service.shutdown();
  });

  it('runs the developer before the lead and attaches verified reviews to an improvement', async () => {
    const store = new TeamBoardStore(':memory:');
    const order: string[] = [];
    let submitted = false;
    const service = new TeamBoardService(
      store,
      async (_board, dotId, prompt) => {
        order.push(dotId);
        if (dotId === 'dev') submitted = true;
        if (dotId === 'lead') expect(prompt).toContain('review-1');
        return 'Result';
      },
      () => {},
      () =>
        submitted
          ? [
              {
                id: 'review-1',
                title: 'Fix',
                summary: 'Fixed cancellation',
                checks: 'PASS',
                diff: '+fixed',
              },
            ]
          : [],
    );
    const board = service.create({
      ...input,
      participants: ['lead', 'dev', 'research'],
      mode: 'improvement',
      developerId: 'dev',
      rounds: 1,
    });
    await vi.waitFor(() =>
      expect(store.get(board.id).status).toBe('awaiting_review'),
    );
    expect(order).toEqual(['research', 'dev', 'lead']);
    expect(store.get(board.id).reviewIds).toEqual(['review-1']);
    await service.shutdown();
  });

  it('automatically shares findings across rounds and lets the lead decide last', async () => {
    const store = new TeamBoardStore(':memory:');
    const turns: string[] = [];
    const service = new TeamBoardService(
      store,
      async (board, dotId, prompt) => {
        turns.push(dotId);
        if (turns.length > 1)
          expect(prompt).toContain('Evidence from research');
        if (turns.length === 1)
          service.post(
            board.id,
            dotId,
            board.threads[dotId],
            'Interim finding',
          );
        return dotId === 'research'
          ? 'Evidence from research'
          : 'Choose option A';
      },
      () => {},
    );
    const board = service.create(input);
    expect(() => service.create(input)).toThrow(/already running/);
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('decided'));
    expect(turns).toEqual(['research', 'lead', 'research', 'lead']);
    expect(store.get(board.id)).toMatchObject({
      turns: 4,
      decision: 'Choose option A',
    });
    expect(store.get(board.id).messages).toHaveLength(5);
    await service.shutdown();
  });

  it('cancels an active turn and never records its late answer as a decision', async () => {
    const store = new TeamBoardStore(':memory:');
    let finish!: (text: string) => void;
    const service = new TeamBoardService(
      store,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      () => {},
    );
    const board = service.create(input);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(() =>
      service.post(board.id, 'research', 'unrelated-thread', 'Spoof'),
    ).toThrow();
    service.stop(board.id);
    finish('Late answer');
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('stopped'));
    expect(store.get(board.id).decision).toBeNull();
    expect(store.get(board.id).messages).toHaveLength(0);
    await service.shutdown();
  });

  it('blocks on a failed turn without fabricating a decision', async () => {
    const store = new TeamBoardStore(':memory:');
    const service = new TeamBoardService(
      store,
      async () => {
        throw new Error('Model unavailable');
      },
      () => {},
    );
    const board = service.create(input);
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('blocked'));
    expect(store.get(board.id)).toMatchObject({
      decision: null,
      error: 'Model unavailable',
    });
    await service.shutdown();
  });

  it('persists discussions and marks interrupted work blocked after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'team-board-'));
    try {
      const path = join(directory, 'board.sqlite');
      const store = new TeamBoardStore(path);
      const service = new TeamBoardService(
        store,
        async () => 'answer',
        () => {},
      );
      const board = service.create(input, 'origin-conversation');
      await vi.waitFor(() =>
        expect(store.get(board.id).status).toBe('decided'),
      );
      const completed = store.get(board.id);
      store.save({
        ...completed,
        id: 'interrupted',
        status: 'running',
        decision: null,
      });
      await service.shutdown();
      const reopened = new TeamBoardStore(path);
      expect(reopened.get(board.id)).toEqual(completed);
      expect(reopened.get(board.id).originThreadId).toBe('origin-conversation');
      expect(reopened.get('interrupted').status).toBe('blocked');
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('validates requests and rejects duplicate participants and unknown boards', async () => {
    const service = new TeamBoardService(
      new TeamBoardStore(':memory:'),
      async () => 'answer',
      () => {},
    );
    const app = teamBoardRoutes(service);
    const response = await app.request('/team-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, participants: ['lead', 'lead'] }),
    });
    expect(response.status).toBe(400);
    expect((await app.request('/team-board/missing')).status).toBe(404);
    expect(() => service.create({ ...input, rounds: 6 })).toThrow();
    expect(() => service.create({ ...input, leadId: 'absent' })).toThrow();
    await service.shutdown();
  });
});
