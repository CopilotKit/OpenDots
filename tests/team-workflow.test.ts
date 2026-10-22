import { expect, it, vi } from 'vitest';
import { TeamBoardService, TeamBoardStore } from '../src/server/team-board.js';
import {
  assignSteps,
  reportStep,
  reviewStep,
  checkpointStep,
} from '../src/server/team-workflow.js';

const input = {
  objective: 'Read the email, draft a reply, then visit the website',
  participants: ['manager', 'operator', 'writer'],
  leadId: 'manager',
  mode: 'workflow' as const,
};

it('rejects reused evidence, repeated progress, and a fourth continuation', async () => {
  const store = new TeamBoardStore(':memory:');
  const service = new TeamBoardService(
    store,
    async () => 'unused',
    () => {},
  );
  store.save({
    ...input,
    id: 'bounded',
    rounds: 1,
    turns: 0,
    status: 'running',
    activeDotId: 'operator',
    threads: { operator: 'worker' },
    messages: [],
    createdAt: Date.now(),
    decision: null,
    error: null,
    steps: [
      {
        id: 'step',
        assigneeId: 'operator',
        task: 'Inspect documents',
        acceptance: 'Contents recorded',
        status: 'running',
        reportPending: true,
        receiptStart: 0,
        attempts: 1,
      },
    ],
  });
  try {
    for (let i = 0; i < 4; i++) {
      const board = store.get('bounded');
      board.steps![0].reportPending = true;
      board.messages.push({
        id: `receipt-${i}`,
        dotId: 'operator',
        kind: 'evidence',
        text: `read_file: document ${i}`,
        createdAt: Date.now(),
      });
      store.save(board);
      const request = {
        stepId: 'step',
        completed: `Read document ${i}`,
        remaining: 'Read remaining documents',
        nextAction: 'Read next document',
        receiptId: `receipt-${i}`,
      };
      if (i === 1) {
        expect(() =>
          checkpointStep(service, 'bounded', 'operator', 'worker', {
            ...request,
            receiptId: 'receipt-0',
          }),
        ).toThrow(/No new/);
        expect(() =>
          checkpointStep(service, 'bounded', 'operator', 'worker', {
            ...request,
            completed: 'Read document 0',
          }),
        ).toThrow(/No new/);
      }
      if (i === 3)
        expect(() =>
          checkpointStep(service, 'bounded', 'operator', 'worker', request),
        ).toThrow(/Continuation limit/);
      else checkpointStep(service, 'bounded', 'operator', 'worker', request);
    }
    expect(store.get('bounded').steps![0].attempts).toBe(1);
    expect(store.get('bounded').steps![0].checkpoints).toHaveLength(3);
  } finally {
    await service.shutdown();
  }
});

it.each(['early end', 'cycle limit', 'context budget'])(
  'continues from a saved checkpoint after %s without replaying completed work',
  async (ending) => {
    const store = new TeamBoardStore(':memory:');
    const actions: string[] = [];
    const service = new TeamBoardService(
      store,
      async (board, actor, prompt) => {
        if (actor === 'manager') {
          if (!board.steps?.length)
            assignSteps(service, board.id, actor, board.threads[actor], [
              {
                assigneeId: 'operator',
                task: 'Read two documents',
                acceptance: 'Both document contents',
              },
            ]);
          else
            reviewStep(service, board.id, actor, board.threads[actor], {
              stepId: board.steps[0].id,
              action: 'accept',
              reason: 'Both receipts checked',
            });
        } else {
          const step = board.steps![0];
          if (step.reportPending) {
            expect(prompt).toContain('REPORTING ONLY');
            const receiptId = board.messages.find(
              (message) => message.kind === 'evidence',
            )!.id;
            expect(() =>
              checkpointStep(service, board.id, actor, board.threads[actor], {
                stepId: step.id,
                completed: 'Read first document',
                remaining: 'Read second document',
                nextAction: 'Read second document',
                receiptId: 'invented',
              }),
            ).toThrow(/receipt/);
            checkpointStep(service, board.id, actor, board.threads[actor], {
              stepId: step.id,
              completed: 'Read first document',
              remaining: 'Read second document',
              nextAction: 'Read second document',
              receiptId,
            });
          } else if (!step.checkpoints?.length) {
            actions.push('read first');
            service.evidence(board.id, actor, 'read_file: First document text');
            if (ending === 'context budget')
              throw new Error(
                'Task checkpoint required: context budget reached.',
              );
            if (ending === 'cycle limit')
              throw new Error(
                'Task incomplete: reached the 20-cycle execution limit.',
              );
          } else {
            expect(prompt).toContain('Read first document');
            expect(step.attempts).toBe(1);
            actions.push('read second');
            reportStep(service, board.id, actor, board.threads[actor], {
              stepId: step.id,
              outcome: 'done',
              result: 'Both documents read',
              evidence: 'First and second contents',
            });
          }
        }
        return 'Saved progress';
      },
      () => {},
    );
    try {
      const board = service.create(input);
      await vi.waitFor(() =>
        expect(store.get(board.id).status).toBe('completed'),
      );
      expect(actions).toEqual(['read first', 'read second']);
      expect(store.get(board.id).steps![0].checkpoints).toHaveLength(1);
    } finally {
      await service.shutdown();
    }
  },
);

it('repairs an omitted report without repeating execution or consuming another attempt', async () => {
  const store = new TeamBoardStore(':memory:');
  let executions = 0;
  let reports = 0;
  const service = new TeamBoardService(
    store,
    async (board, actor, prompt) => {
      if (actor === 'manager') {
        if (!board.steps?.length)
          assignSteps(service, board.id, actor, board.threads[actor], [
            {
              assigneeId: 'operator',
              task: 'Open the account menu',
              acceptance: 'Sign out label visible',
            },
          ]);
        else
          reviewStep(service, board.id, actor, board.threads[actor], {
            stepId: board.steps[0].id,
            action: 'accept',
            reason: 'Receipt confirms Sign out label',
          });
      } else if (board.steps![0].reportPending) {
        reports++;
        expect(prompt).toContain('REPORTING ONLY');
        expect(prompt).toContain('Observed Sign out label');
        expect(board.steps![0].attempts).toBe(1);
        reportStep(service, board.id, actor, board.threads[actor], {
          stepId: board.steps![0].id,
          outcome: 'done',
          result: 'Account menu opened',
          evidence: 'Observed Sign out label',
        });
      } else {
        executions++;
        return 'Observed Sign out label';
      }
      return 'Saved';
    },
    () => {},
  );
  try {
    const board = service.create(input);
    await vi.waitFor(() =>
      expect(store.get(board.id).status).toBe('completed'),
    );
    expect(executions).toBe(1);
    expect(reports).toBe(1);
    expect(store.get(board.id).steps![0]).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    expect(store.get(board.id).steps![0].reportPending).toBeUndefined();
  } finally {
    await service.shutdown();
  }
});

it('repairs reporting after execution retries are exhausted without running or accepting work', async () => {
  const store = new TeamBoardStore(':memory:');
  const runTurn = vi.fn(async () => 'No assignments');
  const service = new TeamBoardService(store, runTurn, () => {});
  try {
    const board = service.create(input);
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('blocked'));
    const blocked = store.get(board.id);
    blocked.steps = [
      {
        id: 'step',
        assigneeId: 'operator',
        task: 'Inspect target',
        acceptance: 'Recorded text',
        status: 'blocked',
        attempts: 2,
      },
    ];
    store.save(blocked);
    const before = runTurn.mock.calls.length;
    const report = {
      result: 'Target inspected',
      evidence: 'Original tool receipt',
    };
    const repaired = service.resubmitReport(board.id, 'step', report);
    expect(repaired.steps![0]).toMatchObject({
      status: 'review',
      attempts: 2,
      ...report,
    });
    expect(repaired.status).toBe('blocked');
    const repeated = service.resubmitReport(board.id, 'step', report);
    expect(repeated.messages).toHaveLength(repaired.messages.length);
    expect(runTurn).toHaveBeenCalledTimes(before);
    expect(() => service.resubmitReport(board.id, 'missing', report)).toThrow();
    repaired.status = 'running';
    store.save(repaired);
    expect(() => service.resubmitReport(board.id, 'step', report)).toThrow(
      /inactive/,
    );
  } finally {
    await service.shutdown();
  }
});

it('does not consume step slots when the manager repeats the same plan', async () => {
  const store = new TeamBoardStore(':memory:');
  const service = new TeamBoardService(
    store,
    async (board, actor) => {
      const steps = Array.from({ length: 6 }, (_, index) => ({
        assigneeId: 'operator',
        task: `Read document ${index}`,
        acceptance: 'Return source text',
      }));
      const first = assignSteps(
        service,
        board.id,
        actor,
        board.threads[actor],
        steps,
      );
      const second = assignSteps(
        service,
        board.id,
        actor,
        board.threads[actor],
        steps,
      );
      const third = assignSteps(
        service,
        board.id,
        actor,
        board.threads[actor],
        steps.map((step) => ({ ...step, task: step.task.toUpperCase() })),
      );
      expect(second.map((step) => step.id)).toEqual(
        first.map((step) => step.id),
      );
      expect(third).toHaveLength(6);
      service.stop(board.id);
      return 'Stopped test';
    },
    () => {},
  );
  try {
    const board = service.create(input);
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('stopped'));
    expect(store.get(board.id).steps).toHaveLength(6);
  } finally {
    await service.shutdown();
  }
});

it('continues from saved assignments and reports when turn streams fail, without repeating specialist work', async () => {
  const store = new TeamBoardStore(':memory:');
  let managerTurns = 0;
  let specialistTurns = 0;
  const service = new TeamBoardService(
    store,
    async (board, actor) => {
      if (actor === 'manager') {
        managerTurns++;
        if (managerTurns === 1)
          throw new Error('Temporary provider connection failure');
        if (!board.steps?.length) {
          assignSteps(service, board.id, actor, board.threads[actor], [
            {
              assigneeId: 'operator',
              task: 'Create the requested note',
              acceptance: 'Saved note receipt',
            },
          ]);
          throw new Error('Stream ended after assignment');
        }
        reviewStep(service, board.id, actor, board.threads[actor], {
          stepId: board.steps[0].id,
          action: 'accept',
          reason: 'Saved note receipt verified',
        });
        return 'Note verified';
      }
      specialistTurns++;
      reportStep(service, board.id, actor, board.threads[actor], {
        stepId: board.steps![0].id,
        outcome: 'done',
        result: 'Note saved',
        evidence: 'Saved note receipt',
      });
      throw new Error('Stream ended after reporting');
    },
    () => {},
  );
  try {
    const board = service.create(input);
    await vi.waitFor(() =>
      expect(store.get(board.id).status).toBe('completed'),
    );
    expect(managerTurns).toBe(3);
    expect(specialistTurns).toBe(1);
    expect(store.get(board.id).steps![0]).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
  } finally {
    await service.shutdown();
  }
});

it('routes an uncertain specialist failure to the manager without automatically repeating the action', async () => {
  const store = new TeamBoardStore(':memory:');
  let specialistTurns = 0;
  const service = new TeamBoardService(
    store,
    async (board, actor) => {
      if (actor === 'manager') {
        if (!board.steps?.length)
          assignSteps(service, board.id, actor, board.threads[actor], [
            {
              assigneeId: 'operator',
              task: 'Send the requested message',
              acceptance: 'Send receipt',
            },
          ]);
        else {
          expect(board.steps[0].result).toContain('uncertain');
          expect(() =>
            assignSteps(service, board.id, actor, board.threads[actor], [
              {
                assigneeId: 'operator',
                task: 'Unrelated new work',
                acceptance: 'New result',
              },
            ]),
          ).toThrow(/Resolve the existing step/);
          reviewStep(service, board.id, actor, board.threads[actor], {
            stepId: board.steps[0].id,
            action: 'block',
            reason: 'Send outcome unknown; receipt unavailable',
          });
        }
        return 'Reviewed';
      }
      specialistTurns++;
      throw new Error('Disconnected while sending');
    },
    () => {},
  );
  try {
    const board = service.create(input);
    await vi.waitFor(() => expect(store.get(board.id).status).toBe('blocked'));
    expect(specialistTurns).toBe(1);
    expect(store.get(board.id).error).toContain('Send outcome unknown');
  } finally {
    await service.shutdown();
  }
});

it('lets the manager assign a dependent chain and reviews every handoff before the next specialist runs', async () => {
  const store = new TeamBoardStore(':memory:');
  const actors: string[] = [];
  const service = new TeamBoardService(
    store,
    async (board, actor, prompt) => {
      actors.push(actor);
      if (actor === 'manager') {
        if (!board.steps?.length)
          assignSteps(service, board.id, actor, board.threads[actor], [
            {
              assigneeId: 'operator',
              task: 'Read the specified email',
              acceptance: 'Record the exact sender and content',
            },
            {
              assigneeId: 'writer',
              task: 'Draft the reply',
              acceptance: 'Use the content recorded by Operator',
            },
          ]);
        else {
          const step = board.steps.find((step) => step.status === 'review')!;
          reviewStep(service, board.id, actor, board.threads[actor], {
            stepId: step.id,
            action: 'accept',
            reason: 'Matches the recorded evidence',
          });
        }
      } else {
        const step = board.steps!.find((step) => step.status === 'running')!;
        if (actor === 'writer') {
          expect(prompt).toContain('Verified email content');
          expect(board.steps![0].status).toBe('completed');
        }
        expect(() =>
          reviewStep(service, board.id, actor, board.threads[actor], {
            stepId: step.id,
            action: 'accept',
            reason: 'Self approved',
          }),
        ).toThrow(/manager/);
        reportStep(service, board.id, actor, board.threads[actor], {
          stepId: step.id,
          outcome: 'done',
          result:
            actor === 'operator'
              ? 'Verified email content'
              : 'Draft reply text',
          evidence: 'Exact observed text',
        });
      }
      return 'Result posted';
    },
    () => {},
  );
  const board = service.create(input);
  await vi.waitFor(() => expect(store.get(board.id).status).toBe('completed'));
  expect(actors).toEqual([
    'manager',
    'operator',
    'manager',
    'writer',
    'manager',
  ]);
  expect(
    store.get(board.id).steps?.every((step) => step.status === 'completed'),
  ).toBe(true);
  await service.shutdown();
});

it('blocks dependent actions when a specialist only narrates success without reporting a result', async () => {
  const store = new TeamBoardStore(':memory:');
  const actors: string[] = [];
  const service = new TeamBoardService(
    store,
    async (board, actor) => {
      actors.push(actor);
      if (actor === 'manager' && !board.steps?.length)
        assignSteps(service, board.id, actor, board.threads[actor], [
          {
            assigneeId: 'operator',
            task: 'Inspect email',
            acceptance: 'Actual email content',
          },
          {
            assigneeId: 'writer',
            task: 'Write reply',
            acceptance: 'Reply to actual content',
          },
        ]);
      return 'I did everything successfully';
    },
    () => {},
  );
  const board = service.create(input);
  await vi.waitFor(() => expect(store.get(board.id).status).toBe('blocked'));
  expect(actors).not.toContain('writer');
  expect(actors.filter((actor) => actor === 'operator')).toHaveLength(2);
  expect(store.get(board.id).steps![0].status).toBe('blocked');
  expect(store.get(board.id).steps![0].attempts).toBe(1);
  await service.shutdown();
});

it('allows one corrected retry without replaying accepted steps', async () => {
  const store = new TeamBoardStore(':memory:');
  const service = new TeamBoardService(
    store,
    async (board, actor) => {
      if (actor === 'manager') {
        if (!board.steps?.length)
          assignSteps(service, board.id, actor, board.threads[actor], [
            {
              assigneeId: 'operator',
              task: 'Read the target',
              acceptance: 'Exact target text',
            },
          ]);
        else {
          const step = board.steps[0];
          if (step.attempts === 2)
            expect(() =>
              reviewStep(service, board.id, actor, board.threads[actor], {
                stepId: step.id,
                action: 'retry',
                reason: 'Third attempt',
              }),
            ).toThrow(/limit/);
          reviewStep(service, board.id, actor, board.threads[actor], {
            stepId: step.id,
            action: step.attempts === 1 ? 'retry' : 'accept',
            reason:
              step.attempts === 1
                ? 'Read the full target text'
                : 'Verified full text',
          });
        }
      } else {
        const step = board.steps![0];
        if (step.attempts === 2)
          expect(step.feedback).toBe('Read the full target text');
        reportStep(service, board.id, actor, board.threads[actor], {
          stepId: step.id,
          outcome: 'done',
          result: 'Read target',
          evidence: 'Observed target text',
        });
      }
      return 'Turn completed';
    },
    () => {},
  );
  const board = service.create(input);
  await vi.waitFor(() => expect(store.get(board.id).status).toBe('completed'));
  expect(store.get(board.id).steps![0].attempts).toBe(2);
  await service.shutdown();
});
