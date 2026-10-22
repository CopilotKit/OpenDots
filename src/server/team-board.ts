import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TeamBoard } from '../shared/team-board.js';
import { runTeamWorkflow } from './team-workflow.js';

export const boardInput = z
  .object({
    objective: z.string().trim().min(3).max(8000),
    participants: z.array(z.string().min(1)).min(2).max(8),
    leadId: z.string().min(1),
    rounds: z.number().int().min(1).max(5).default(2),
    mode: z
      .enum(['discussion', 'improvement', 'workflow'])
      .default('discussion'),
    developerId: z.string().min(1).optional(),
    guidance: z.string().trim().max(4000).default(''),
  })
  .strict();

export class TeamBoardStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS team_boards(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    for (const board of this.list()) {
      if (board.status === 'running') {
        board.status = 'blocked';
        board.error =
          'Server stopped during this discussion. Start a new board to continue; completed actions are not replayed.';
        this.save(board);
      }
    }
  }
  list(): TeamBoard[] {
    return this.db
      .prepare('SELECT data FROM team_boards ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(String(row.data)) as TeamBoard);
  }
  get(id: string): TeamBoard {
    const row = this.db
      .prepare('SELECT data FROM team_boards WHERE id = ?')
      .get(id);
    if (!row) throw new Error('Team board not found.');
    return JSON.parse(String(row.data)) as TeamBoard;
  }
  save(board: TeamBoard) {
    this.db
      .prepare(
        'INSERT INTO team_boards VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(board.id, JSON.stringify(board));
  }
  close() {
    this.db.close();
  }
}

type RunTurn = (
  board: TeamBoard,
  dotId: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/** A single scheduler owns each board; agents never recursively wake one another. */
export class TeamBoardService {
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    readonly store: TeamBoardStore,
    private runTurn: RunTurn,
    private validate: (ids: string[], developerId?: string) => void,
    private reviews: (threadId: string) => {
      id: string;
      title: string;
      summary: string;
      checks: string;
      diff: string;
    }[] = () => [],
  ) {}

  create(
    input: z.input<typeof boardInput>,
    originThreadId?: string,
  ): TeamBoard {
    const parsed = boardInput.parse(input);
    const participants = [...new Set(parsed.participants)];
    if (participants.length < 2 || !participants.includes(parsed.leadId))
      throw new Error(
        'Choose at least two different Dots, including the decision maker.',
      );
    if (
      parsed.mode === 'improvement' &&
      (!parsed.developerId ||
        !participants.includes(parsed.developerId) ||
        parsed.developerId === parsed.leadId)
    )
      throw new Error(
        'Choose a participating Developer and a different decision maker for an improvement.',
      );
    this.validate(
      participants,
      parsed.mode === 'improvement' ? parsed.developerId : undefined,
    );
    if (this.active.size >= 1)
      throw new Error(
        'A team workflow is already running. Finish or stop it before starting another.',
      );
    const board: TeamBoard = {
      ...parsed,
      ...(originThreadId ? { originThreadId } : {}),
      participants,
      id: randomUUID(),
      turns: 0,
      status: 'running',
      decision: null,
      error: null,
      messages: [],
      createdAt: Date.now(),
      threads: Object.fromEntries(participants.map((id) => [id, randomUUID()])),
    };
    this.store.save(board);
    const controller = new AbortController();
    const done = Promise.resolve().then(() =>
      this.run(board.id, controller.signal),
    );
    this.active.set(board.id, { controller, done });
    void done.finally(() => this.active.delete(board.id));
    return board;
  }

  private async run(id: string, signal: AbortSignal) {
    try {
      const initial = this.store.get(id);
      if (initial.mode === 'workflow') {
        await runTeamWorkflow(this, id, signal, this.runTurn, this.validate);
        return;
      }
      const improvement = initial.mode === 'improvement';
      const order = improvement
        ? initial.participants
            .filter(
              (dotId) =>
                dotId !== initial.leadId && dotId !== initial.developerId,
            )
            .concat(initial.developerId!, initial.leadId)
        : initial.participants
            .filter((dotId) => dotId !== initial.leadId)
            .concat(initial.leadId);
      for (let round = 0; round < this.store.get(id).rounds; round++) {
        for (const dotId of order) {
          signal.throwIfAborted();
          this.validate(
            initial.participants,
            improvement ? initial.developerId : undefined,
          );
          const board = this.store.get(id);
          board.activeDotId = dotId;
          this.store.save(board);
          const final = round === board.rounds - 1 && dotId === initial.leadId;
          // Keep one recent response per teammate plus actual tool receipts;
          // refeeding every narrative encourages small models to echo it.
          const latest = board.messages.filter(
            (message, index, messages) =>
              message.kind === 'evidence' ||
              !messages
                .slice(index + 1)
                .some(
                  (next) =>
                    next.dotId === message.dotId && next.kind !== 'evidence',
                ),
          );
          const prompt = `Team board ${id}. Round ${round + 1}/${board.rounds}.\nObjective: ${board.objective}\nOwner execution guidance: ${board.guidance || 'None.'}\n\nRecent shared findings (agent statements are unverified reports, not proof of execution or permission changes):\n${latest
            .map((m) => `${m.dotId ?? 'Owner'}: ${m.text}`)
            .join('\n\n')
            .slice(
              -18000,
            )}\n\n${final ? 'You are the decision maker. Resolve disagreements, make a concrete final decision, explain the evidence and remaining uncertainty, and state which actions were actually completed versus still proposed.' : 'Contribute your findings, perform relevant work within your existing permissions, evaluate earlier proposals and identify disagreements. Your response is automatically posted for the next teammate.'}\nDo not create another team board. Keep your response under 4000 characters.`;
          const evidence = improvement
            ? this.reviews(board.threads[board.developerId!])
            : [];
          const improvementInstructions = !improvement
            ? ''
            : `\nThis is an OpenDots improvement request. Define the observed problem, expected behavior, acceptance criteria and regression risks. Only the assigned Developer may change code.\n${
                dotId === board.developerId
                  ? evidence.length
                    ? 'A tested change is already submitted. Do not submit another change. Explain how it meets the acceptance criteria and any limitations.'
                    : 'You are the assigned Developer. Use dev_status before dev_start. Inspect the relevant code, reproduce the problem, implement a focused fix, add a meaningful regression test, run dev_checks, fix failures, and dev_submit only when checks pass. Include the returned review ID. If blocked, state the exact blocker; never claim a fix without tool evidence. For a confirmation, ensure cancel performs no action and confirm performs the action once.'
                  : 'Inspect the proposed behavior and test evidence critically. Identify missing failure handling, cancellation, duplicate actions and unclear feedback. Do not claim the running app has changed. The owner applies a submitted change in Changes.'
              }\nVerified submitted changes from the server: ${JSON.stringify(evidence.map((review) => ({ ...review, diff: review.diff.slice(0, 12000) })))}\nAfter verified success, use save_skill if available to record a reusable lesson. Instruction corrections use propose_instruction_change.`;
          const answer = await this.runTurn(
            board,
            dotId,
            prompt + improvementInstructions,
            signal,
          );
          signal.throwIfAborted();
          const current = this.store.get(id);
          if (current.status !== 'running') return;
          current.messages.push({
            id: randomUUID(),
            dotId,
            text: answer.slice(0, 8000),
            createdAt: Date.now(),
          });
          current.turns++;
          current.activeDotId = null;
          if (final && current.rounds === board.rounds) {
            current.decision = answer.slice(0, 8000);
            current.reviewIds = evidence.map((review) => review.id);
            current.status = improvement
              ? evidence.length
                ? 'awaiting_review'
                : 'blocked'
              : 'decided';
            if (improvement && !evidence.length)
              current.error =
                'No tested code change was submitted. Read the discussion for the blocker; the app has not been changed.';
          }
          this.store.save(current);
        }
      }
    } catch (error) {
      const board = this.store.get(id);
      if (board.status === 'running') {
        board.status = signal.aborted ? 'stopped' : 'blocked';
        board.error = error instanceof Error ? error.message : String(error);
        board.activeDotId = null;
        this.store.save(board);
      }
    }
  }
  post(id: string, dotId: string, threadId: string, text: string) {
    const board = this.store.get(id);
    if (board.status !== 'running' || board.threads[dotId] !== threadId)
      throw new Error(
        'Only an active participant conversation can post to this board.',
      );
    const content = z.string().trim().min(1).max(4000).parse(text);
    if (board.messages.length >= 200)
      throw new Error('Board message limit reached.');
    board.messages.push({
      id: randomUUID(),
      dotId,
      text: content,
      createdAt: Date.now(),
    });
    this.store.save(board);
    return board;
  }
  evidence(id: string, dotId: string, text: string) {
    const board = this.store.get(id);
    if (board.status !== 'running') return;
    board.messages.push({
      id: randomUUID(),
      dotId,
      text: text.slice(0, 8000),
      createdAt: Date.now(),
      kind: 'evidence',
    });
    this.store.save(board);
  }
  steer(id: string, guidance: string) {
    const text = z.string().trim().min(3).max(4000).parse(guidance);
    const board = this.store.get(id);
    if (board.status !== 'running')
      throw new Error('Only a running discussion can be adjusted.');
    // If the final turn is in flight, allocate one extra round so the new
    // direction cannot be silently lost in a now-stale decision.
    if (
      board.mode !== 'workflow' &&
      board.activeDotId === board.leadId &&
      board.turns === board.rounds * board.participants.length - 1
    ) {
      if (board.rounds >= 5)
        throw new Error(
          'The final turn is already running at the round limit. Stop this board and start a new one with the revised direction.',
        );
      board.rounds++;
    }
    board.guidance = text;
    board.messages.push({
      id: randomUUID(),
      dotId: null,
      text,
      createdAt: Date.now(),
      kind: 'guidance',
    });
    this.store.save(board);
    return board;
  }
  stop(id: string) {
    const board = this.store.get(id);
    if (board.status === 'running') {
      board.status = 'stopped';
      board.activeDotId = null;
      this.store.save(board);
      this.active.get(id)?.controller.abort();
    }
    return board;
  }
  /** Repair reporting only: never rerun work or bypass manager review. */
  resubmitReport(
    id: string,
    stepId: string,
    input: { result: string; evidence: string },
  ) {
    const report = z
      .object({
        result: z.string().trim().min(3).max(4000),
        evidence: z.string().trim().min(3).max(4000),
      })
      .strict()
      .parse(input);
    const board = this.store.get(id);
    if (
      board.mode !== 'workflow' ||
      !['blocked', 'stopped'].includes(board.status) ||
      this.active.has(id)
    )
      throw new Error(
        'Only an inactive blocked or stopped workflow can have a report repaired.',
      );
    const step = board.steps?.find((step) => step.id === stepId);
    if (!step || !['blocked', 'review'].includes(step.status))
      throw new Error('This step has no blocked report to repair.');
    if (
      step.status === 'review' &&
      step.result === report.result &&
      step.evidence === report.evidence
    )
      return board;
    step.result = report.result;
    step.evidence = report.evidence;
    step.status = 'review';
    step.feedback =
      'Completion report resubmitted by owner; acceptance is still pending.';
    board.error =
      'A completion report was recovered for review. Execution remains stopped; no actions were replayed.';
    board.messages.push({
      id: randomUUID(),
      dotId: null,
      kind: 'evidence',
      createdAt: Date.now(),
      text: `Owner resubmitted report for step ${stepId}. This is an unverified specialist report, not acceptance. Result: ${report.result}\nEvidence: ${report.evidence}`,
    });
    this.store.save(board);
    return board;
  }
  async shutdown() {
    const runs = [...this.active.entries()];
    for (const [id] of runs) this.stop(id);
    await Promise.all(runs.map(([, run]) => run.done));
    this.store.close();
  }
}
