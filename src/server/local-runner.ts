import {
  InMemoryAgentRunner,
  ɵGLOBAL_STORE as memory,
  type AgentRunnerRunRequest,
} from '@copilotkit/runtime/v2';
import type { BaseEvent, Message } from '@ag-ui/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** A run saved mid-flight (server stopped) is closed with a visible error. */
export function closeInterrupted(events: BaseEvent[]): BaseEvent[] {
  const last = events.at(-1)?.type;
  if (!events.length || last === 'RUN_FINISHED' || last === 'RUN_ERROR')
    return events;
  return [
    ...events,
    {
      type: 'RUN_ERROR',
      message:
        'This reply was interrupted because OpenDots stopped. Send your message again to continue.',
    } as BaseEvent,
  ];
}
/**
 * Streamed pieces of one message joined into one event: a long trading run
 * stored ~64,000 events (one per word), and replaying them on reopening the
 * chat froze the page. The joined events give the same messages.
 */
export function compactEvents(events: BaseEvent[]): BaseEvent[] {
  const joinable = new Set([
    'TEXT_MESSAGE_CONTENT',
    'REASONING_MESSAGE_CONTENT',
    'TOOL_CALL_ARGS',
  ]);
  const out: BaseEvent[] = [];
  for (const event of events) {
    const piece = event as BaseEvent & {
      delta?: string;
      messageId?: string;
      toolCallId?: string;
    };
    const last = out.at(-1) as typeof piece | undefined;
    if (
      joinable.has(event.type) &&
      last?.type === event.type &&
      last.messageId === piece.messageId &&
      last.toolCallId === piece.toolCallId &&
      typeof last.delta === 'string' &&
      typeof piece.delta === 'string'
    )
      out[out.length - 1] = { ...last, delta: last.delta + piece.delta };
    else out.push(event);
  }
  return out;
}
// Durable local conversations: the SDK's in-memory runner handles streaming,
// replay, and stop semantics; each finished run is mirrored into SQLite and
// rehydrated on startup, so no conversation data leaves this machine.
export class SqliteAgentRunner extends InMemoryAgentRunner {
  private db: DatabaseSync;
  /** Called after each run is saved, e.g. to index it into long-term memory. */
  onPersist?: (threadId: string, messages: Message[]) => void;
  constructor(path: string) {
    super({ maxRunsPerThread: 200 });
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_threads(id TEXT PRIMARY KEY, agentId TEXT NOT NULL, messages TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_runs(threadId TEXT NOT NULL, runId TEXT NOT NULL, agentId TEXT NOT NULL, parentRunId TEXT, events TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, runId));`);
    this.rehydrate();
  }
  private rehydrate() {
    const threads = this.db
      .prepare('SELECT id, messages FROM local_threads')
      .all() as { id: string; messages: string }[];
    const runs = this.db.prepare(
      'SELECT runId, agentId, parentRunId, events, createdAt FROM local_runs WHERE threadId = ? ORDER BY createdAt',
    );
    for (const thread of threads) {
      const rows = runs.all(thread.id) as {
        runId: string;
        agentId: string;
        parentRunId: string | null;
        events: string;
        createdAt: number;
      }[];
      if (!rows.length) continue;
      memory.getOrCreate(thread.id);
      rows.forEach((row, index) =>
        memory.appendRun(thread.id, {
          threadId: thread.id,
          runId: row.runId,
          agentId: row.agentId,
          parentRunId: row.parentRunId,
          events: closeInterrupted(
            compactEvents(JSON.parse(row.events) as BaseEvent[]),
          ),
          // appendRun keeps the latest non-empty snapshot at thread level.
          messages:
            index === rows.length - 1
              ? (JSON.parse(thread.messages) as Message[])
              : [],
          createdAt: row.createdAt,
        }),
      );
    }
  }
  run(request: AgentRunnerRunRequest) {
    const events = super.run(request);
    // Save progress while the run streams, so a crash or restart never loses
    // the owner's message or the work done so far.
    const seen: BaseEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkpoint = () => {
      timer = undefined;
      this.checkpoint(request, seen);
    };
    const finish = () => {
      clearTimeout(timer);
      this.persist(request.threadId, request.input.runId);
    };
    // Subscribe independently so the run persists even if the client disconnects.
    events.subscribe({
      next: (event) => {
        seen.push(event);
        if (seen.length === 1) checkpoint();
        else timer ??= setTimeout(checkpoint, 1500);
      },
      complete: finish,
      error: finish,
    });
    return events;
  }
  close() {
    this.db.close();
  }
  /** Drop a conversation's saved and in-memory history (stop its run first). */
  forget(threadId: string) {
    this.db.prepare('DELETE FROM local_runs WHERE threadId = ?').run(threadId);
    this.db.prepare('DELETE FROM local_threads WHERE id = ?').run(threadId);
    const store = memory.peek(threadId);
    if (store)
      (
        memory as unknown as {
          removeThread(id: string, value: typeof store): void;
        }
      ).removeThread(threadId, store);
  }
  /** Interim save of an in-flight run; the final persist replaces it. */
  private checkpoint(request: AgentRunnerRunRequest, events: BaseEvent[]) {
    const now = Date.now();
    const agentId = request.agent.agentId ?? 'default';
    this.db
      .prepare(
        `INSERT INTO local_threads(id, agentId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updatedAt = excluded.updatedAt`,
      )
      .run(
        request.threadId,
        agentId,
        JSON.stringify(request.input.messages ?? []),
        now,
        now,
      );
    this.db
      .prepare(
        `INSERT INTO local_runs(threadId, runId, agentId, parentRunId, events, createdAt) VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(threadId, runId) DO UPDATE SET events = excluded.events`,
      )
      .run(
        request.threadId,
        request.input.runId,
        agentId,
        JSON.stringify(events),
        now,
      );
  }
  private persist(threadId: string, runId: string) {
    const store = memory.peek(threadId);
    const run = store?.historicRuns.find((item) => item.runId === runId);
    if (!store || !run) return;
    // Keep the joined events for replay too, not only on disk.
    (run as { events: BaseEvent[] }).events = compactEvents(run.events);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO local_threads(id, agentId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updatedAt = excluded.updatedAt`,
      )
      .run(
        threadId,
        run.agentId,
        JSON.stringify(store.messagesSnapshot),
        store.createdAt ?? now,
        now,
      );
    this.db
      .prepare(
        'INSERT OR REPLACE INTO local_runs(threadId, runId, agentId, parentRunId, events, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        threadId,
        runId,
        run.agentId,
        run.parentRunId,
        JSON.stringify(run.events),
        run.createdAt,
      );
    this.onPersist?.(threadId, store.messagesSnapshot);
  }
}
