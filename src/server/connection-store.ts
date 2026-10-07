import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
type Row = Omit<Connection, 'hasToken' | 'signedIn' | 'tools'> & {
  token: string | null;
  tools: string;
};
// OAuth client state for one connection, kept server-side only.
export interface OAuthState {
  redirectUrl: string | null;
  client: unknown;
  tokens: unknown;
  verifier: string | null;
  discovery: unknown;
}
const oauthJson = ['client', 'tokens', 'discovery'] as const;
export class ConnectionStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_oauth(connectionId TEXT PRIMARY KEY, redirectUrl TEXT, client TEXT, tokens TEXT, verifier TEXT, discovery TEXT, state TEXT, stateExpires INTEGER);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
    if (
      !db
        .prepare('PRAGMA table_info(mcp_connections)')
        .all()
        .some((column) => column.name === 'authMode')
    )
      db.exec(
        "ALTER TABLE mcp_connections ADD COLUMN authMode TEXT NOT NULL DEFAULT 'token'",
      );
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
    return {
      ...row,
      hasToken: !!token,
      signedIn: row.authMode === 'oauth' && !!this.oauth(row.id).tokens,
      tools: JSON.parse(tools),
    };
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
    authMode: Connection['authMode'] = 'token',
  ): Connection {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO mcp_connections (id, dotId, name, url, token, tools, error, createdAt, updatedAt, authMode) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
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
        authMode,
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
    this.db.prepare('DELETE FROM mcp_oauth WHERE connectionId=?').run(id);
    return (
      this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
        .changes > 0
    );
  }
  oauth(id: string): OAuthState {
    const row = this.db
      .prepare('SELECT * FROM mcp_oauth WHERE connectionId=?')
      .get(id);
    const parse = (value: unknown) =>
      typeof value === 'string' ? JSON.parse(value) : undefined;
    return {
      redirectUrl:
        typeof row?.redirectUrl === 'string' ? row.redirectUrl : null,
      client: parse(row?.client),
      tokens: parse(row?.tokens),
      verifier: typeof row?.verifier === 'string' ? row.verifier : null,
      discovery: parse(row?.discovery),
    };
  }
  saveOAuth(id: string, patch: Partial<OAuthState>) {
    const next = { ...this.oauth(id), ...patch };
    const json = Object.fromEntries(
      oauthJson.map((key) => [
        key,
        next[key] === undefined ? null : JSON.stringify(next[key]),
      ]),
    );
    this.db
      .prepare(
        `INSERT INTO mcp_oauth (connectionId, redirectUrl, client, tokens, verifier, discovery) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connectionId) DO UPDATE SET redirectUrl=excluded.redirectUrl, client=excluded.client, tokens=excluded.tokens, verifier=excluded.verifier, discovery=excluded.discovery`,
      )
      .run(
        id,
        next.redirectUrl,
        json.client,
        json.tokens,
        next.verifier,
        json.discovery,
      );
    // Signing in or out changes what the Dot can do: stop active turns.
    if ('tokens' in patch)
      this.db
        .prepare('UPDATE mcp_connections SET updatedAt=? WHERE id=?')
        .run(this.tick(id), id);
  }
  // One pending sign-in per connection; the state is single-use.
  setState(id: string, state: string, expires: number) {
    this.saveOAuth(id, {});
    this.db
      .prepare(
        'UPDATE mcp_oauth SET state=?, stateExpires=? WHERE connectionId=?',
      )
      .run(state, expires, id);
  }
  takeState(state: string) {
    const row = this.db
      .prepare('SELECT connectionId, stateExpires FROM mcp_oauth WHERE state=?')
      .get(state);
    if (!row) return undefined;
    this.db
      .prepare(
        'UPDATE mcp_oauth SET state=NULL, stateExpires=NULL WHERE connectionId=?',
      )
      .run(row.connectionId);
    return Number(row.stateExpires) > Date.now()
      ? String(row.connectionId)
      : undefined;
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
        'SELECT status, result, approvalId FROM mcp_actions WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    if (!row) return undefined;
    return {
      approvalId: typeof row.approvalId === 'string' ? row.approvalId : null,
      status: String(row.status) as 'running' | 'done',
      result:
        typeof row.result === 'string'
          ? (JSON.parse(row.result) as ConnectionActionResult)
          : null,
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
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
        )
        .run(threadId, toolCallId, connectionId, tool, Date.now(), approvalId)
        .changes > 0
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
