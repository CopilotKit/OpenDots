import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
type Row = Omit<Connection, 'hasToken' | 'tools'> & {
  token: string | null;
  tools: string;
};
/**
 * Longest a claimed action may stay result-less before it counts as
 * interrupted. Tool calls are bounded to 60 seconds, so a claim this old
 * cannot belong to a live run.
 */
export const STALE_ACTION_MS = 5 * 60 * 1000;

export class ConnectionStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
    // A receipt belongs to the approval that produced it.
    if (
      !db
        .prepare('PRAGMA table_info(mcp_actions)')
        .all()
        .some((column) => column.name === 'approvalId')
    )
      db.exec('ALTER TABLE mcp_actions ADD COLUMN approvalId TEXT');
  }
  private rows(dotId?: string) {
    return this.db
      .prepare(
        `SELECT * FROM mcp_connections ${dotId ? 'WHERE dotId=?' : ''} ORDER BY createdAt, rowid`,
      )
      .all(...(dotId ? [dotId] : [])) as unknown as Row[];
  }
  private view({ token, tools, ...row }: Row): Connection {
    return { ...row, hasToken: !!token, tools: JSON.parse(tools) };
  }
  list(dotId: string): Connection[] {
    return this.rows(dotId).map((row) => this.view(row));
  }
  get(id: string): Connection | undefined {
    const row = this.rows().find((row) => row.id === id);
    return row && this.view(row);
  }
  // Secrets never leave the server: only the MCP transport reads them.
  credentials(id: string) {
    const row = this.rows().find((row) => row.id === id);
    if (!row) throw new Error('Connection not found.');
    return { url: row.url, token: row.token ?? undefined };
  }
  create(
    dotId: string,
    value: { name: string; url: string; token?: string },
    tools: ConnectionTool[],
  ): Connection {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO mcp_connections VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(
        id,
        dotId,
        value.name,
        value.url,
        value.token || null,
        JSON.stringify(tools),
        now,
        now,
      );
    return this.get(id)!;
  }
  saveTools(id: string, tools: ConnectionTool[], error: string | null = null) {
    this.db
      .prepare(
        'UPDATE mcp_connections SET tools=?, error=?, updatedAt=? WHERE id=?',
      )
      .run(JSON.stringify(tools), error, this.tick(id), id);
    return this.get(id)!;
  }
  setError(id: string, error: string) {
    this.db
      .prepare('UPDATE mcp_connections SET error=?, updatedAt=? WHERE id=?')
      .run(error, this.tick(id), id);
    return this.get(id)!;
  }
  remove(id: string) {
    return (
      this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
        .changes > 0
    );
  }
  // Running turns compare this to stop as soon as the owner changes access.
  fingerprint(dotId: string) {
    return this.rows(dotId)
      .map((row) => `${row.id}:${row.updatedAt}`)
      .join(',');
  }
  // Keep updatedAt strictly increasing so rapid edits always change the fingerprint.
  private tick(id: string) {
    return Math.max(Date.now(), (this.get(id)?.updatedAt ?? 0) + 1);
  }
  // Binds a gated call to its exact connection, tool, and arguments, so a
  // later approval runs that call and nothing else.
  createApproval(value: {
    threadId: string;
    dotId: string;
    connectionId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        value.threadId,
        value.dotId,
        value.connectionId,
        value.tool,
        JSON.stringify(value.arguments),
        Date.now(),
      );
    return id;
  }
  approval(id: string) {
    const row = this.db
      .prepare('SELECT * FROM mcp_approvals WHERE id=?')
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      dotId: String(row.dotId),
      connectionId: String(row.connectionId),
      tool: String(row.tool),
      arguments: JSON.parse(String(row.arguments)) as Record<string, unknown>,
      createdAt: Number(row.createdAt),
    };
  }
  action(threadId: string, toolCallId: string) {
    const row = this.db
      .prepare(
        'SELECT status, result, approvalId, createdAt FROM mcp_actions WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    if (!row) return undefined;
    const status = String(row.status) as 'running' | 'done';
    const result =
      typeof row.result === 'string'
        ? (JSON.parse(row.result) as ConnectionActionResult)
        : null;
    // A result-less claim older than the longest possible tool call belongs
    // to a server that died mid-run. Surface it as interrupted, not absent:
    // the owner should know the earlier attempt may have happened before
    // approving a replay. The claim path reclaims the row atomically, so a
    // live run is never disturbed.
    const interrupted =
      status === 'running' &&
      result === null &&
      Number(row.createdAt) < Date.now() - STALE_ACTION_MS;
    return {
      approvalId: typeof row.approvalId === 'string' ? row.approvalId : null,
      status: interrupted ? ('interrupted' as const) : status,
      result,
    };
  }
  // Claim an approved action once. Returns false if it was already claimed,
  // so a double click or a retried request never executes twice.
  claimAction(
    threadId: string,
    toolCallId: string,
    approvalId: string,
    connectionId: string,
    tool: string,
  ) {
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
      )
      .run(threadId, toolCallId, connectionId, tool, Date.now(), approvalId);
    if (inserted.changes > 0) return true;
    // Reclaim an interrupted run: a result-less running row past the tool
    // timeout, and only for the approval that claimed it. Refreshing
    // createdAt makes a concurrent reclaim lose, so a fresh running row
    // still guards against a double click.
    return (
      this.db
        .prepare(
          "UPDATE mcp_actions SET createdAt=?, connectionId=?, tool=? WHERE threadId=? AND toolCallId=? AND approvalId=? AND status='running' AND result IS NULL AND createdAt < ?",
        )
        .run(
          Date.now(),
          connectionId,
          tool,
          threadId,
          toolCallId,
          approvalId,
          Date.now() - STALE_ACTION_MS,
        ).changes > 0
    );
  }
  finishAction(
    threadId: string,
    toolCallId: string,
    result: ConnectionActionResult,
  ) {
    this.db
      .prepare(
        "UPDATE mcp_actions SET status='done', result=? WHERE threadId=? AND toolCallId=?",
      )
      .run(JSON.stringify(result), threadId, toolCallId);
  }
}
