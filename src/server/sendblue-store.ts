import type { DatabaseSync } from 'node:sqlite';
const RETAIN_HANDLES_MS = 7 * 86_400_000;
export class SendblueStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS sendblue_threads(number TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sendblue_inbound(handle TEXT PRIMARY KEY, receivedAt INTEGER NOT NULL);`);
  }
  thread(number: string) {
    const row = this.db
      .prepare('SELECT threadId FROM sendblue_threads WHERE number=?')
      .get(number);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  setThread(number: string, threadId: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO sendblue_threads VALUES (?, ?)')
      .run(number, threadId);
  }
  // Records a provider message handle once; false means a redelivery.
  claim(handle: string, now = Date.now()) {
    this.db
      .prepare('DELETE FROM sendblue_inbound WHERE receivedAt < ?')
      .run(now - RETAIN_HANDLES_MS);
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO sendblue_inbound VALUES (?, ?)')
        .run(handle, now).changes === 1
    );
  }
}
