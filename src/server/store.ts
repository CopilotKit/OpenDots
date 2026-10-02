import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Action,
  Detail,
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
  InboxItem,
  Watcher,
} from '../shared/types.js';

export type Claim = Task & { lease: string };
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, taskId TEXT, createdAt INTEGER NOT NULL, readAt INTEGER, dismissedAt INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_created ON inbox(createdAt DESC);
      CREATE TABLE IF NOT EXISTS watchers (id TEXT PRIMARY KEY, url TEXT NOT NULL, prompt TEXT NOT NULL, threadId TEXT NOT NULL, intervalSeconds INTEGER NOT NULL, lastCheckedAt INTEGER, lastHash TEXT, nextCheckAt INTEGER NOT NULL, enabled INTEGER NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS watchers_due ON watchers(enabled, nextCheckAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)')
      .run(JSON.stringify(defaults));
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    return JSON.parse(row.value) as Settings;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    return this.transaction(() => {
      const previous = this.settings();
      const settings = { ...previous, ...patch };
      this.db
        .prepare('UPDATE settings SET value=? WHERE id=1')
        .run(JSON.stringify(settings));
      if (
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed)
      ) {
        const running = this.tasks().filter((t) => t.status === 'running');
        for (const task of running) {
          this.invalidate(
            task,
            'queued',
            'Run stopped because settings changed.',
          );
        }
      }
      return settings;
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all() as unknown as Task[];
  }
  task(id: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id=?')
      .get(id) as unknown as Task | undefined;
  }
  createTask(prompt: string, intervalSeconds: number | null = null): Task {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?, 'queued', ?, NULL, ?, ?, NULL, NULL, NULL)",
      )
      .run(id, prompt, intervalSeconds, now, now);
    this.event(id, null, 'Task added to the research queue.');
    return this.task(id)!;
  }
  detail(id: string): Detail | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC',
      )
      .all(id) as unknown as (Omit<Run, 'result'> & {
      result: string | null;
    })[];
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result ? (JSON.parse(row.result) as Result) : null,
      })),
      events: this.db
        .prepare('SELECT * FROM events WHERE taskId=? ORDER BY id')
        .all(id) as unknown as TaskEvent[],
    };
  }
  event(taskId: string, runId: string | null, text: string) {
    this.db
      .prepare(
        'INSERT INTO events (taskId, runId, text, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, runId, text, Date.now());
  }
  private invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running'",
        )
        .run(now, reason, task.lease);
    this.db
      .prepare(
        'UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?',
      )
      .run(status, now, task.id);
    this.event(task.id, task.lease, reason);
  }
  action(id: string, action: Action): Task | undefined {
    return this.transaction(() => {
      const task = this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      this.db
        .prepare('UPDATE tasks SET error=NULL, nextRunAt=NULL WHERE id=?')
        .run(id);
      return this.task(id);
    });
  }
  schedule(id: string, intervalSeconds: number | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const next =
      intervalSeconds && task.status === 'completed'
        ? Date.now() + intervalSeconds * 1000
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET intervalSeconds=?, nextRunAt=?, updatedAt=? WHERE id=?',
      )
      .run(intervalSeconds, next, Date.now(), id);
    this.event(
      id,
      null,
      intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.',
    );
    return this.task(id);
  }
  claim(now = Date.now()): Claim | null {
    return this.transaction(() => {
      const settings = this.settings();
      if (settings.paused || !settings.researchAllowed) return null;
      const expired = this.db
        .prepare("SELECT * FROM tasks WHERE status='running' AND leaseUntil<=?")
        .all(now) as unknown as Task[];
      for (const task of expired)
        this.invalidate(
          task,
          'queued',
          'Previous worker lease expired; safely retrying.',
        );
      const task = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' OR (status='completed' AND nextRunAt IS NOT NULL AND nextRunAt<=?) ORDER BY createdAt LIMIT 1",
        )
        .get(now) as unknown as Task | undefined;
      if (!task) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, updatedAt=? WHERE id=?",
        )
        .run(lease, now + 180_000, now, task.id);
      this.db
        .prepare(
          "INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL)",
        )
        .run(lease, task.id, now);
      this.event(task.id, lease, 'Research worker started.');
      return { ...this.task(task.id)!, lease };
    });
  }
  owns(claim: Claim): boolean {
    const task = this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(claim)) return false;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=?",
        )
        .run(now, JSON.stringify(result), claim.lease);
      this.db
        .prepare(
          "UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, updatedAt=?, nextRunAt=? WHERE id=?",
        )
        .run(
          now,
          task.intervalSeconds ? now + task.intervalSeconds * 1000 : null,
          claim.id,
        );
      this.event(
        claim.id,
        claim.lease,
        result.sample
          ? 'Fictional sample brief ready.'
          : 'Research brief ready.',
      );
      this.createInboxItem(
        'task_completed',
        'Research is ready',
        task.prompt + '\\n\\n' + result.text.slice(0, 800),
        claim.id,
      );
      return true;
    });
  }
  release(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'queued', reason);
    });
  }
  fail(claim: Claim, error: string) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=?",
        )
        .run(now, error, claim.lease);
      this.db
        .prepare(
          "UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, updatedAt=? WHERE id=?",
        )
        .run(error, now, claim.id);
      this.event(claim.id, claim.lease, error);
      this.createInboxItem(
        'task_failed',
        'A task needs attention',
        claim.prompt + '\\n\\n' + error.slice(0, 800),
        claim.id,
      );
    });
  }
  inbox(limit = 100): InboxItem[] {
    return this.db
      .prepare(
        'SELECT * FROM inbox WHERE dismissedAt IS NULL ORDER BY createdAt DESC LIMIT ?',
      )
      .all(limit) as unknown as InboxItem[];
  }
  unreadInboxCount(): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM inbox WHERE dismissedAt IS NULL AND readAt IS NULL',
      )
      .get() as { count: number };
    return Number(row.count);
  }
  createInboxItem(
    kind: InboxItem['kind'],
    title: string,
    body: string,
    taskId: string | null = null,
  ): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      kind,
      title,
      body,
      taskId,
      createdAt: Date.now(),
      readAt: null,
      dismissedAt: null,
    };
    this.db
      .prepare('INSERT INTO inbox VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
      .run(
        item.id,
        item.kind,
        item.title,
        item.body,
        item.taskId,
        item.createdAt,
      );
    return item;
  }
  inboxAction(
    id: string,
    action: 'read' | 'unread' | 'dismiss',
  ): InboxItem | undefined {
    const existing = this.db
      .prepare('SELECT * FROM inbox WHERE id=?')
      .get(id) as unknown as InboxItem | undefined;
    if (!existing) return undefined;
    const readAt =
      action === 'read'
        ? Date.now()
        : action === 'unread'
          ? null
          : existing.readAt;
    const dismissedAt =
      action === 'dismiss' ? Date.now() : existing.dismissedAt;
    this.db
      .prepare('UPDATE inbox SET readAt=?, dismissedAt=? WHERE id=?')
      .run(readAt, dismissedAt, id);
    return this.db
      .prepare('SELECT * FROM inbox WHERE id=?')
      .get(id) as unknown as InboxItem;
  }
  watchers(): Watcher[] {
    return this.db
      .prepare('SELECT * FROM watchers ORDER BY createdAt DESC')
      .all()
      .map((row) => ({
        ...row,
        intervalSeconds: Number(row.intervalSeconds),
        enabled: !!row.enabled,
      })) as unknown as Watcher[];
  }
  dueWatchers(now = Date.now()): Watcher[] {
    return this.db
      .prepare(
        'SELECT * FROM watchers WHERE enabled=1 AND nextCheckAt<=? ORDER BY nextCheckAt LIMIT 20',
      )
      .all(now)
      .map((row) => ({
        ...row,
        intervalSeconds: Number(row.intervalSeconds),
        enabled: !!row.enabled,
      })) as unknown as Watcher[];
  }
  createWatcher(
    url: string,
    prompt: string,
    threadId: string,
    intervalSeconds: number,
  ): Watcher {
    const now = Date.now();
    const watcher: Watcher = {
      id: randomUUID(),
      url,
      prompt,
      threadId,
      intervalSeconds,
      lastCheckedAt: null,
      lastHash: null,
      nextCheckAt: now,
      enabled: true,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO watchers VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, ?, ?)',
      )
      .run(
        watcher.id,
        watcher.url,
        watcher.prompt,
        watcher.threadId,
        watcher.intervalSeconds,
        watcher.nextCheckAt,
        watcher.createdAt,
        watcher.updatedAt,
      );
    return watcher;
  }
  updateWatcherCheck(
    id: string,
    patch: {
      lastCheckedAt: number;
      lastHash?: string | null;
      nextCheckAt: number;
      error?: string | null;
    },
  ): Watcher | undefined {
    this.db
      .prepare(
        'UPDATE watchers SET lastCheckedAt=?, lastHash=COALESCE(?, lastHash), nextCheckAt=?, error=?, updatedAt=? WHERE id=?',
      )
      .run(
        patch.lastCheckedAt,
        patch.lastHash ?? null,
        patch.nextCheckAt,
        patch.error ?? null,
        Date.now(),
        id,
      );
    return this.watchers().find((watcher) => watcher.id === id);
  }
  watcherAction(
    id: string,
    action: 'pause' | 'resume' | 'delete',
  ): Watcher | undefined {
    const existing = this.watchers().find((watcher) => watcher.id === id);
    if (!existing) return undefined;
    if (action === 'delete') {
      this.db.prepare('DELETE FROM watchers WHERE id=?').run(id);
      return undefined;
    }
    this.db
      .prepare(
        'UPDATE watchers SET enabled=?, error=NULL, updatedAt=? WHERE id=?',
      )
      .run(action === 'resume' ? 1 : 0, Date.now(), id);
    return this.watchers().find((watcher) => watcher.id === id);
  }
  memories(): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories ORDER BY createdAt DESC')
      .all() as unknown as Memory[];
  }
  saveMemory(text: string, id: string = randomUUID()): Memory {
    this.db
      .prepare(
        'INSERT INTO memories VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text',
      )
      .run(id, text, Date.now());
    return this.db
      .prepare('SELECT * FROM memories WHERE id=?')
      .get(id) as unknown as Memory;
  }
  deleteMemory(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0
    );
  }
}
