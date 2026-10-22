import { expect, it, vi } from 'vitest';
import { platformTools } from '../src/server/platform-tools.js';
import { TeamBoardService, TeamBoardStore } from '../src/server/team-board.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { starterTeam } from '../src/server/team.js';

it('starts with specialist names and resolves an empty board read to the same originating task', async () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.seedTeam(starterTeam);
  const dot = workspace.dots().find((dot) => dot.name === 'Planner')!;
  const service = new TeamBoardService(
    new TeamBoardStore(':memory:'),
    async () => 'No assignments made in this fake turn',
    (ids) => {
      if (ids.some((id) => !workspace.dot(id)))
        throw new Error('Unknown participant');
    },
  );
  const tools = platformTools({
    config: {
      baseUrl: '',
      runtimeUrl: '',
      voiceName: '',
      slackUsers: [],
      teamBoard: service,
    },
    workspace,
    dot,
    threadId: 'owner-chat',
    depth: 0,
    check: () => {},
    signal: new AbortController().signal,
  });
  try {
    const start = tools.find((tool) => tool.name === 'start_team_workflow')!;
    const read = tools.find((tool) => tool.name === 'read_team_board')!;
    const started = await start.execute!({
      objective: 'Read the project files',
      specialists: ['Vision', 'Researcher', 'The Operator'],
    });
    expect(started).toMatchObject({
      started: true,
      originThreadId: 'owner-chat',
      participants: [
        dot.id,
        ...['Vision', 'Researcher', 'Operator'].map(
          (name) => workspace.dots().find((dot) => dot.name === name)!.id,
        ),
      ],
    });
    await vi.waitFor(() =>
      expect(service.store.list()[0].status).toBe('blocked'),
    );
    const result = await read.execute!({});
    expect(result).toMatchObject({
      id: service.store.list()[0].id,
      linkedToThisConversation: true,
      status: 'blocked',
      running: false,
    });
  } finally {
    await service.shutdown();
    workspace.close();
  }
});
