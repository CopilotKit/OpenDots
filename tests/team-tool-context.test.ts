import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { starterTeam } from '../src/server/team.js';
import {
  resolveBoardId,
  resolveSpecialist,
  teamStatus,
} from '../src/server/team-tool-context.js';
import type { TeamBoard } from '../src/shared/team-board.js';

const blocked: TeamBoard = {
  id: 'old-board',
  objective: 'Unrelated old task',
  participants: ['manager', 'worker'],
  leadId: 'manager',
  rounds: 2,
  turns: 5,
  status: 'blocked',
  decision: null,
  error: 'No response',
  threads: { manager: 'old-manager', worker: 'old-worker' },
  messages: [],
  createdAt: 1,
};

it('resolves the specialist names the manager actually sent, without accepting unknown names', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    workspace.seedTeam(starterTeam);
    const dots = workspace.dots();
    for (const name of ['Vision', 'Researcher', 'Operator'])
      expect(resolveSpecialist(name, dots)).toBe(
        dots.find((dot) => dot.name === name)!.id,
      );
    expect(resolveSpecialist(' The Operator ', dots)).toBe(
      dots.find((dot) => dot.name === 'Operator')!.id,
    );
    expect(() => resolveSpecialist('imaginary', dots)).toThrow(/No specialist/);
    expect(() =>
      resolveSpecialist('Vision', [
        ...dots,
        { ...dots.find((dot) => dot.name === 'Vision')!, id: 'duplicate' },
      ]),
    ).toThrow(/Several/);
  } finally {
    workspace.close();
  }
});

it('never substitutes an old blocked board when the current conversation has not started a workflow', () => {
  expect(() => resolveBoardId([blocked], 'new-chat', 'manager')).toThrow(
    /No workflow has been started here/,
  );
  const current = {
    ...blocked,
    id: 'new-board',
    originThreadId: 'new-chat',
    threads: { manager: 'participant-chat' },
  };
  expect(resolveBoardId([current, blocked], 'new-chat', 'manager')).toBe(
    'new-board',
  );
  expect(
    resolveBoardId([current, blocked], 'participant-chat', 'manager'),
  ).toBe('new-board');
  expect(
    resolveBoardId([current, blocked], 'new-chat', 'manager', 'old-board'),
  ).toBe('old-board');
  expect(teamStatus(blocked)).toMatchObject({
    running: false,
    statusMeaning: expect.stringContaining('Execution has stopped'),
  });
});
