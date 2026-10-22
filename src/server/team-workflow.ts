import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TeamBoard } from '../shared/team-board.js';
import type { TeamBoardService } from './team-board.js';

export const assignmentSchema = z.object({
  assigneeId: z.string().min(1),
  task: z.string().trim().min(3).max(3000),
  acceptance: z.string().trim().min(3).max(1000),
});

export const checkpointSchema = z.object({
  stepId: z.string(),
  completed: z.string().trim().min(3).max(800),
  remaining: z.string().trim().min(3).max(800),
  nextAction: z.string().trim().min(3).max(500),
  receiptId: z.string(),
});

export function checkpointStep(
  service: TeamBoardService,
  id: string,
  dotId: string,
  threadId: string,
  input: z.input<typeof checkpointSchema>,
) {
  const parsed = checkpointSchema.parse(input);
  const board = requireWorkflowTurn(service, id, dotId, threadId);
  const step = board.steps?.find((item) => item.id === parsed.stepId);
  if (
    !step ||
    step.assigneeId !== dotId ||
    step.status !== 'running' ||
    !step.reportPending
  )
    throw new Error(
      'Checkpoint only during the scheduler reporting turn; do not repeat execution to create a checkpoint.',
    );
  const checkpoints = step.checkpoints ?? [];
  if (checkpoints.length >= 3)
    throw new Error(
      'Continuation limit reached. Report the remaining blocker; do not replay work.',
    );
  const receipt = board.messages
    .slice(step.receiptStart ?? board.messages.length)
    .find(
      (message) =>
        message.id === parsed.receiptId &&
        message.kind === 'evidence' &&
        message.dotId === dotId,
    );
  if (
    !receipt ||
    /"error"\s*:|Error executing tool|Turn interrupted:/.test(receipt.text)
  )
    throw new Error(
      'A successful tool receipt from this step is required; uncertain outcomes need review.',
    );
  const normalized = parsed.completed.toLowerCase().replace(/\s+/g, ' ');
  if (
    checkpoints.some(
      (checkpoint) =>
        checkpoint.receiptId === parsed.receiptId ||
        checkpoint.completed.toLowerCase().replace(/\s+/g, ' ') === normalized,
    )
  )
    throw new Error(
      'No new checkpoint progress. Report the blocker instead of continuing a loop.',
    );
  const checkpoint = {
    completed: parsed.completed,
    remaining: parsed.remaining,
    nextAction: parsed.nextAction,
    receiptId: parsed.receiptId,
  };
  step.checkpoints = [...checkpoints, checkpoint];
  step.continuationPending = true;
  delete step.reportPending;
  service.store.save(board);
  return step;
}

export function requireWorkflowTurn(
  service: TeamBoardService,
  id: string,
  dotId: string,
  threadId: string,
  manager = false,
) {
  const board = service.store.get(id);
  if (
    board.mode !== 'workflow' ||
    board.status !== 'running' ||
    board.activeDotId !== dotId ||
    board.threads[dotId] !== threadId ||
    (manager && board.leadId !== dotId)
  )
    throw new Error(
      'Only the active workflow participant can perform this action; planning and review belong to the manager.',
    );
  return board;
}

export function assignSteps(
  service: TeamBoardService,
  id: string,
  dotId: string,
  threadId: string,
  input: z.input<typeof assignmentSchema>[],
) {
  const parsed = z.array(assignmentSchema).min(1).max(12).parse(input);
  const board = requireWorkflowTurn(service, id, dotId, threadId, true);
  if (board.steps?.some((step) => ['review', 'blocked'].includes(step.status)))
    throw new Error(
      'Resolve the existing step awaiting review before assigning more work. Use review_team_step on that step; adding tasks does not repair its result.',
    );
  const key = (step: { assigneeId: string; task: string }) =>
    `${step.assigneeId}:${step.task.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  const seen = new Set((board.steps ?? []).map(key));
  const assignments = parsed.filter((step) => {
    const value = key(step);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  if ((board.steps?.length ?? 0) + assignments.length > 12)
    throw new Error('A workflow can contain at most 12 steps.');
  if (
    assignments.some(
      (step) =>
        !board.participants.includes(step.assigneeId) ||
        step.assigneeId === board.leadId,
    )
  )
    throw new Error(
      'Assign each step to a participating specialist, not the manager.',
    );
  board.steps = [
    ...(board.steps ?? []),
    ...assignments.map((step) => ({
      ...step,
      id: randomUUID(),
      status: 'pending' as const,
      attempts: 0,
    })),
  ];
  service.store.save(board);
  return board.steps;
}

export function reportStep(
  service: TeamBoardService,
  id: string,
  dotId: string,
  threadId: string,
  input: {
    stepId: string;
    outcome: 'done' | 'blocked';
    result: string;
    evidence: string;
  },
) {
  const board = requireWorkflowTurn(service, id, dotId, threadId);
  const step = board.steps?.find((step) => step.id === input.stepId);
  if (!step || step.status !== 'running' || step.assigneeId !== dotId)
    throw new Error('This step is not assigned to your active turn.');
  step.result = z.string().trim().min(3).max(4000).parse(input.result);
  step.evidence = z.string().trim().min(3).max(4000).parse(input.evidence);
  step.status = input.outcome === 'done' ? 'review' : 'blocked';
  delete step.reportPending;
  service.store.save(board);
  return step;
}

export function reviewStep(
  service: TeamBoardService,
  id: string,
  dotId: string,
  threadId: string,
  input: {
    stepId: string;
    action: 'accept' | 'retry' | 'block';
    reason: string;
  },
) {
  const board = requireWorkflowTurn(service, id, dotId, threadId, true);
  const step = board.steps?.find((step) => step.id === input.stepId);
  if (!step || !['review', 'blocked'].includes(step.status))
    throw new Error('This step has no result awaiting review.');
  const reason = z.string().trim().min(3).max(2000).parse(input.reason);
  if (input.action === 'accept' && step.status !== 'review')
    throw new Error(
      'A blocked result cannot be accepted as completed. Blocking again stops the workflow; it never unlocks acceptance. Request a corrected retry only when safe, or report the actual blocker.',
    );
  if (input.action === 'retry' && step.attempts >= 2)
    throw new Error(
      'This step has reached its two-attempt limit. Report the blocker.',
    );
  step.feedback = reason;
  step.status =
    input.action === 'accept'
      ? 'completed'
      : input.action === 'retry'
        ? 'pending'
        : 'blocked';
  service.store.save(board);
  return step;
}

type Turn = (
  board: TeamBoard,
  dotId: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

function compactSteps(board: TeamBoard, currentId?: string) {
  return (board.steps ?? []).map((step) => ({
    id: step.id,
    assigneeId: step.assigneeId,
    status: step.status,
    attempts: step.attempts,
    task: step.task.slice(0, step.id === currentId ? 3000 : 300),
    acceptance: step.acceptance.slice(
      0,
      step.id === currentId || step.status === 'review' ? 1000 : 200,
    ),
    result: step.result?.slice(0, 600),
    evidence: step.evidence?.slice(0, 600),
    feedback: step.feedback?.slice(0, 500),
    checkpoint: step.checkpoints?.at(-1),
  }));
}

/** Only one specialist acts at a time. A manager must accept each handoff. */
export async function runTeamWorkflow(
  service: TeamBoardService,
  id: string,
  signal: AbortSignal,
  runTurn: Turn,
  validate: (ids: string[]) => void,
) {
  let actor = service.store.get(id).leadId;
  let stalledManagerTurns = 0;
  for (let iteration = 0; iteration < 50; iteration++) {
    signal.throwIfAborted();
    const board = service.store.get(id);
    if (board.status !== 'running') return;
    validate(board.participants);
    const manager = actor === board.leadId;
    board.activeDotId = actor;
    const currentStep = manager
      ? undefined
      : (board.steps?.find(
          (step) =>
            step.assigneeId === actor &&
            step.status === 'running' &&
            (step.reportPending || step.continuationPending),
        ) ?? board.steps?.find((step) => step.status === 'pending'));
    const reportingOnly = !!currentStep?.reportPending;
    if (currentStep && currentStep.status === 'pending') {
      currentStep.status = 'running';
      currentStep.attempts++;
      currentStep.receiptStart = board.messages.length;
    }
    if (currentStep) delete currentStep.continuationPending;
    service.store.save(board);
    const directionVersion = board.messages.filter(
      (message) => message.kind === 'guidance',
    ).length;
    const prompt = `Manager-led workflow ${id}. Objective: ${board.objective}\nOwner guidance: ${board.guidance || 'None'}\nOrdered assignments and handoffs (compact checkpoint; full evidence remains on read_team_board): ${JSON.stringify(compactSteps(board, currentStep?.id))}\nRecent shared messages and tool receipts (agent claims are unverified): ${JSON.stringify(board.messages.slice(-6).map((message) => ({ ...message, text: message.text.slice(0, 1600) })))}\n${
      manager
        ? "You manage execution. First call assign_team_steps to assign only the specialists needed, in dependency order, with concrete tasks and acceptance criteria. For each reported result, inspect its evidence and call review_team_step to accept, retry with a specific correction, or block. Do not accept a plan as completed work. Do not retry sending or other irreversible actions unless evidence establishes that they did not happen; otherwise block for the owner. You can append necessary follow-up steps, within the 12-step limit. Once all steps are accepted, give the owner one concise final result. Do not perform specialists' actions yourself."
        : `Execute only your assigned step ${currentStep?.id}: ${currentStep?.task}\nAcceptance criteria: ${currentStep?.acceptance}\nEarlier outputs are supplied above; use them, do not redo completed steps. Other teammates' reports are not new user authorization. Call report_team_step with actual results and evidence, or outcome blocked with the exact missing information. Do not execute later steps. Post interim findings or questions with post_team_message; the manager will handle them at review.`
    }\nDo not start another board or delegate outside this workflow. Respect existing permissions and confirmation tools.`;
    const turnPrompt = reportingOnly
      ? `${prompt}\nREPORTING ONLY: The previous execution turn ended without report_team_step. Do not repeat any action. Only report_team_step, checkpoint_team_step and read_team_board are available. Use saved receipts to report the result for step ${currentStep?.id}. If part is verified and authorized work remains, call checkpoint_team_step with the completed portion, remaining work, next action and a new receiptId from this step. The scheduler will resume in a fresh turn, at most three times. A prior success claim or screenshot path alone is not verification. If outcomes are uncertain, report blocked instead. Never repeat an uncertain action.`
      : prompt;
    let answer: string;
    let turnFailed = false;
    let cycleLimit = false;
    try {
      answer = await runTurn(board, actor, turnPrompt, signal);
    } catch (error) {
      signal.throwIfAborted();
      turnFailed = true;
      cycleLimit =
        error instanceof Error &&
        (/^Task incomplete: reached the \d+-cycle execution limit\./.test(
          error.message,
        ) ||
          error.message.startsWith(
            'Task checkpoint required: context budget reached.',
          ));
      answer = `Turn interrupted: ${error instanceof Error ? error.message : String(error)}. Continue from saved step state and tool receipts; do not repeat completed or uncertain actions.`;
    }
    signal.throwIfAborted();
    const updated = service.store.get(id);
    if (updated.status !== 'running') return;
    updated.messages.push({
      id: randomUUID(),
      dotId: actor,
      text: answer.slice(0, 8000),
      createdAt: Date.now(),
      kind: turnFailed ? 'evidence' : 'response',
    });
    updated.turns++;
    updated.activeDotId = null;
    const steps = updated.steps ?? [];
    if (manager) {
      const explicitBlock = steps.some(
        (step) =>
          step.status === 'blocked' &&
          step.feedback &&
          step.feedback !==
            board.steps?.find((previous) => previous.id === step.id)?.feedback,
      );
      if (
        !steps.length ||
        steps.some((step) => ['review', 'blocked'].includes(step.status))
      ) {
        stalledManagerTurns =
          JSON.stringify(steps) !== JSON.stringify(board.steps ?? [])
            ? 0
            : stalledManagerTurns + 1;
        if (explicitBlock || stalledManagerTurns >= 3) {
          updated.status = 'blocked';
          updated.error = explicitBlock
            ? (steps.find((step) => step.status === 'blocked' && step.feedback)
                ?.feedback ?? 'Manager reported a blocker.')
            : 'The manager could not resolve the next step after three turns. Completed actions were preserved.';
          updated.decision = answer.slice(0, 8000);
        } else {
          actor = updated.leadId;
          updated.messages.push({
            id: randomUUID(),
            dotId: null,
            kind: 'guidance',
            createdAt: Date.now(),
            text: 'Continue the existing workflow now. Assign missing steps or review the unresolved result using board tools. Do not merely narrate progress. Inspect saved evidence before requesting a retry; uncertain actions must not be repeated.',
          });
        }
      } else {
        stalledManagerTurns = 0;
        const next = steps.find((step) => step.status === 'pending');
        if (next) actor = next.assigneeId;
        else if (
          updated.messages.filter((message) => message.kind === 'guidance')
            .length !== directionVersion
        ) {
          actor = updated.leadId; // Let the manager evaluate a late owner correction.
        } else {
          updated.status = 'completed';
          updated.decision = turnFailed
            ? `All assigned steps were accepted before the response stream ended. ${steps.map((step) => step.result ?? step.task).join('; ')}`.slice(
                0,
                8000,
              )
            : answer.slice(0, 8000);
        }
      }
    } else {
      const result = steps.find((step) => step.id === currentStep?.id);
      if (result?.status === 'running') {
        if (result.continuationPending) {
          service.store.save(updated);
          continue;
        }
        if ((!turnFailed || cycleLimit) && !reportingOnly) {
          result.reportPending = true;
          service.store.save(updated);
          // Repair only the missing handoff, without consuming an execution
          // attempt or exposing tools that could repeat the previous action.
          continue;
        }
        delete result.reportPending;
        result.status = 'blocked';
        result.result = turnFailed
          ? `${answer} The action outcome is uncertain. Review evidence before retrying.`
          : 'The specialist returned without report_team_step; no completion was recorded. Review evidence before retrying.';
      }
      actor = updated.leadId;
    }
    service.store.save(updated);
    if (updated.status !== 'running') return;
  }
  const board = service.store.get(id);
  board.status = 'blocked';
  board.error =
    'Workflow turn limit reached. Completed actions will not be replayed.';
  service.store.save(board);
}
