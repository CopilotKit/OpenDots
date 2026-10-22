import { expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteAgentRunner } from '../src/server/local-runner.js';
import { runLocalTurn } from '../src/server/headless.js';
import { TeamBoardService, TeamBoardStore } from '../src/server/team-board.js';
import { starterTeam } from '../src/server/team.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { completion } from './fixtures/model-stream.js';

it('completes all twelve steps despite hallucinated board IDs and rejects an ordinary-chat retry', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.seedTeam(starterTeam);
  const manager = workspace.dots().find((dot) => dot.name === 'Planner')!;
  const worker = workspace.dots().find((dot) => dot.name === 'Operator')!;
  const runner = new SqliteAgentRunner(':memory:');
  const actors: string[] = [];
  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://unused.invalid/v1',
    runtimeUrl: '',
    voiceName: '',
    slackUsers: [],
  };
  const service = new TeamBoardService(
    new TeamBoardStore(':memory:'),
    async (board, actor, prompt, signal) => {
      actors.push(actor);
      if (
        !workspace
          .conversations()
          .some((thread) => thread.id === board.threads[actor])
      )
        workspace.bindThread(board.threads[actor], actor, 'Workflow');
      return runLocalTurn(
        runner,
        new DotAgent(store, workspace, config, actor, false, 2, board.id),
        board.threads[actor],
        prompt,
        signal,
      );
    },
    () => {},
  );
  config.teamBoard = service;
  const call = (name: string, args: object) =>
    completion(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: name,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      'tool_calls',
    );
  let requests = 0;
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const board = service.store.list()[0];
      const pendingReview = board.steps?.find(
        (step) => step.status === 'review',
      );
      if (pendingReview && board.activeDotId === manager.id) {
        const review = request.tools.find(
          (tool: { function: { name: string } }) =>
            tool.function.name === 'review_team_step',
        );
        expect(review.function.parameters.properties.stepId.enum).toEqual([
          pendingReview.id,
        ]);
      }
      if (board.activeDotId === manager.id) {
        expect(
          request.tools
            .map((tool: { function: { name: string } }) => tool.function.name)
            .sort(),
        ).toEqual([
          'assign_team_steps',
          'post_team_message',
          'read_team_board',
          'review_team_step',
        ]);
      }
      const cycle = requests++;
      if (cycle === 0)
        return call('assign_team_steps', {
          id: 'nonexistent-board',
          steps: Array.from({ length: 12 }, (_, index) => ({
            assigneeId: worker.id,
            task: `Create Notes ${index + 1}`,
            acceptance: 'Saved page contains fixture notes',
          })),
        });
      const index = Math.floor((cycle - 1) / 3);
      const step = board.steps![index];
      expect(
        board
          .steps!.slice(0, index)
          .every((step) => step.status === 'completed'),
      ).toBe(true);
      switch ((cycle - 1) % 3) {
        case 0:
          return call('create_space_page', {
            title: `Notes ${index + 1}`,
            content: 'Fixture notes',
          });
        case 1: {
          expect(workspace.pages.list(worker.spaceId)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ title: `Notes ${index + 1}` }),
            ]),
          );
          return call('report_team_step', {
            // Reproduce a local model confusing a step ID with a board ID.
            // Routing is server-owned even if extra input is hallucinated.
            id: step.id,
            stepId: step.id,
            outcome: 'done',
            result: 'Created Notes',
            evidence: 'create_space_page returned the saved page',
          });
        }
        default:
          return call('review_team_step', {
            id: 'another-wrong-board',
            stepId: step.id,
            action: 'accept',
            reason: 'Saved page matches acceptance criteria',
          });
      }
    });
  try {
    const board = service.create({
      objective: 'Create twelve numbered Notes pages through the specialist',
      mode: 'workflow',
      leadId: manager.id,
      participants: [manager.id, worker.id],
    });
    await vi.waitFor(
      () =>
        expect(service.store.get(board.id)).toMatchObject({
          status: 'completed',
          error: null,
        }),
      { timeout: 10000 },
    );
    expect(actors).toEqual([
      manager.id,
      ...Array.from({ length: 12 }, () => [worker.id, manager.id]).flat(),
    ]);
    expect(requests).toBe(37);
    for (const step of service.store.get(board.id).steps!)
      expect(step).toMatchObject({
        status: 'completed',
        attempts: 1,
      });
    expect(
      workspace.pages
        .list(worker.spaceId)
        .filter((page) => page.title.startsWith('Notes ')),
    ).toHaveLength(12);
    expect(
      runner
        .getThreadMessages(board.threads[worker.id])
        .some((message) => message.role === 'tool'),
    ).toBe(true);
    const before = network.mock.calls.length;
    const events = await lastValueFrom(
      new DotAgent(store, workspace, config, manager.id)
        .run({
          threadId: board.threads[manager.id],
          runId: 'manual-retry',
          messages: [{ id: 'retry', role: 'user', content: 'Try again' }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'RUN_ERROR',
        message: expect.stringContaining('cannot run as ordinary chat'),
      }),
    );
    expect(network).toHaveBeenCalledTimes(before);
  } finally {
    network.mockRestore();
    await service.shutdown();
    runner.close();
    workspace.close();
    store.close();
  }
}, 20000);
