import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
export class ComputerStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  }
  permissions(id: string): ComputerPermissions {
    const row = this.db
      .prepare('SELECT value FROM computer_permissions WHERE dotId=?')
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { enabled: false, browser: false, files: false, shell: false };
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    const value = { ...this.permissions(id), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?)')
      .run(id, JSON.stringify(value));
    return value;
  }
  begin(dotId: string, action: string, actor: 'owner' | 'agent') {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?)')
      .run(id, dotId, action, actor, 'pending', Date.now());
    return id;
  }
  finish(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE computer_audit SET outcome=? WHERE id=?')
      .run(outcome, id);
    this.db
      .prepare(
        `DELETE FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`,
      )
      .run(id, id);
  }
  audit(id: string): ComputerAudit[] {
    return this.db
      .prepare(
        'SELECT id,action,actor,outcome,createdAt FROM computer_audit WHERE dotId=? ORDER BY createdAt DESC,rowid DESC LIMIT 50',
      )
      .all(id) as unknown as ComputerAudit[];
  }
}
