import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { HostShellActionResult } from '../shared/host-shell-types.js';

export class HostShellStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS host_shell_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, timeoutMs INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_shell_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, approvalId TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
  }

  createApproval(value: {
    threadId: string;
    dotId: string;
    command: string;
    cwd: string;
    timeoutMs: number;
  }) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO host_shell_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        value.threadId,
        value.dotId,
        value.command,
        value.cwd,
        value.timeoutMs,
        Date.now(),
      );
    return id;
  }

  approval(id: string) {
    const row = this.db
      .prepare('SELECT * FROM host_shell_approvals WHERE id=?')
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      dotId: String(row.dotId),
      command: String(row.command),
      cwd: String(row.cwd),
      timeoutMs: Number(row.timeoutMs),
      createdAt: Number(row.createdAt),
    };
  }

  action(threadId: string, toolCallId: string) {
    const row = this.db
      .prepare(
        'SELECT status, result, approvalId FROM host_shell_actions WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    if (!row) return undefined;
    return {
      approvalId: String(row.approvalId),
      status: String(row.status) as 'running' | 'done',
      result:
        typeof row.result === 'string'
          ? (JSON.parse(row.result) as HostShellActionResult)
          : null,
    };
  }

  actionForApproval(approvalId: string) {
    const row = this.db
      .prepare(
        'SELECT threadId, toolCallId FROM host_shell_actions WHERE approvalId=?',
      )
      .get(approvalId);
    return row
      ? { threadId: String(row.threadId), toolCallId: String(row.toolCallId) }
      : undefined;
  }

  claimAction(threadId: string, toolCallId: string, approvalId: string) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO host_shell_actions (threadId, toolCallId, approvalId, status, result, createdAt) VALUES (?, ?, ?, 'running', NULL, ?)",
        )
        .run(threadId, toolCallId, approvalId, Date.now()).changes > 0
    );
  }

  finishAction(
    threadId: string,
    toolCallId: string,
    result: HostShellActionResult,
  ) {
    this.db
      .prepare(
        "UPDATE host_shell_actions SET status='done', result=? WHERE threadId=? AND toolCallId=?",
      )
      .run(JSON.stringify(result), threadId, toolCallId);
  }
}
