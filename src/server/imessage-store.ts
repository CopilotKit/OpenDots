import type { DatabaseSync } from 'node:sqlite';
import type { BridgeState } from './imessage.js';
export class IMessageStore implements BridgeState {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS imessage_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imessage_threads(handle TEXT PRIMARY KEY, threadId TEXT NOT NULL);`);
  }
  cursor() {
    const row = this.db
      .prepare("SELECT value FROM imessage_state WHERE key='cursor'")
      .get();
    return row ? Number(row.value) : undefined;
  }
  setCursor(id: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO imessage_state VALUES ('cursor', ?)")
      .run(String(id));
  }
  thread(handle: string) {
    const row = this.db
      .prepare('SELECT threadId FROM imessage_threads WHERE handle=?')
      .get(handle);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  setThread(handle: string, threadId: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO imessage_threads VALUES (?, ?)')
      .run(handle, threadId);
  }
}
