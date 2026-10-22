import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Self-improvement: Dots save procedures that worked ("skills") and propose
// changes to their own instructions. Skills are text guidance only; they never
// change permissions or models. Instruction changes need the owner's approval.
export interface Skill {
  id: string;
  dotId: string | null; // null = shared with every Dot
  name: string;
  whenToUse: string;
  steps: string;
  uses: number;
  createdAt: number;
  updatedAt: number;
}
export interface Proposal {
  id: string;
  dotId: string;
  instructions: string;
  reason: string;
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: number;
}
type Embed = (texts: string[]) => Promise<Float32Array[]>;

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

export class SkillStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private embed?: Embed,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, dotId TEXT, name TEXT NOT NULL, whenToUse TEXT NOT NULL, steps TEXT NOT NULL, embedding BLOB, uses INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills(IFNULL(dotId, ''), lower(name));
      CREATE TABLE IF NOT EXISTS instruction_proposals(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, instructions TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  private row(row: Record<string, unknown>): Skill {
    return {
      id: String(row.id),
      dotId: row.dotId === null ? null : String(row.dotId),
      name: String(row.name),
      whenToUse: String(row.whenToUse),
      steps: String(row.steps),
      uses: Number(row.uses),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }
  /** Skills visible to a Dot: its own plus shared ones. */
  list(dotId: string): Skill[] {
    return this.db
      .prepare(
        'SELECT * FROM skills WHERE dotId = ? OR dotId IS NULL ORDER BY updatedAt DESC',
      )
      .all(dotId)
      .map((row) => this.row(row));
  }
  get(dotId: string, name: string): Skill | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM skills WHERE (dotId = ? OR dotId IS NULL) AND lower(name) = lower(?) ORDER BY dotId IS NULL LIMIT 1',
      )
      .get(dotId, name.trim());
    return row ? this.row(row) : undefined;
  }
  /** Create or update a skill by name (per Dot, or shared). */
  async save(input: {
    dotId: string | null;
    name: string;
    whenToUse: string;
    steps: string;
  }): Promise<Skill> {
    const name = input.name.trim().slice(0, 80);
    const now = Date.now();
    const [vector] = this.embed
      ? await this.embed([`${name}. ${input.whenToUse}`]).catch(() => [])
      : [];
    const existing = this.db
      .prepare(
        "SELECT id FROM skills WHERE IFNULL(dotId, '') = ? AND lower(name) = lower(?)",
      )
      .get(input.dotId ?? '', name);
    const id = existing ? String(existing.id) : randomUUID();
    this.db
      .prepare(
        `INSERT INTO skills(id, dotId, name, whenToUse, steps, embedding, uses, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET whenToUse = excluded.whenToUse, steps = excluded.steps,
           embedding = excluded.embedding, updatedAt = excluded.updatedAt`,
      )
      .run(
        id,
        input.dotId,
        name,
        input.whenToUse.trim().slice(0, 500),
        input.steps.trim().slice(0, 4000),
        vector ? new Uint8Array(vector.buffer) : null,
        now,
        now,
      );
    return this.row(
      this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id)!,
    );
  }
  delete(id: string) {
    return (
      this.db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0
    );
  }
  /** Most relevant skills for a request (embedding similarity, else recent). */
  async relevant(dotId: string, request: string, limit = 3): Promise<Skill[]> {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE dotId = ? OR dotId IS NULL')
      .all(dotId);
    if (!rows.length) return [];
    let ranked = rows.map((row) => ({ row, score: 0 }));
    if (this.embed && request.trim()) {
      try {
        const [query] = await this.embed([request.slice(0, 2000)]);
        ranked = rows.map((row) => {
          const blob = row.embedding as Uint8Array | null;
          const vector = blob
            ? new Float32Array(
                blob.buffer,
                blob.byteOffset,
                blob.byteLength / 4,
              )
            : undefined;
          return { row, score: vector ? cosine(query, vector) : 0 };
        });
        ranked = ranked.filter((item) => item.score > 0.45);
      } catch {
        // Embedding model unavailable: fall back to most recently updated.
      }
    }
    const picked = ranked
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.row.updatedAt) - Number(a.row.updatedAt),
      )
      .slice(0, limit)
      .map((item) => this.row(item.row));
    for (const skill of picked)
      this.db
        .prepare('UPDATE skills SET uses = uses + 1 WHERE id = ?')
        .run(skill.id);
    return picked;
  }
  propose(dotId: string, instructions: string, reason: string): Proposal {
    // One pending proposal per Dot: a newer one replaces the older.
    this.db
      .prepare(
        "UPDATE instruction_proposals SET status = 'dismissed' WHERE dotId = ? AND status = 'pending'",
      )
      .run(dotId);
    const proposal: Proposal = {
      id: randomUUID(),
      dotId,
      instructions: instructions.trim().slice(0, 2000),
      reason: reason.trim().slice(0, 1000),
      status: 'pending',
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO instruction_proposals VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        proposal.id,
        dotId,
        proposal.instructions,
        proposal.reason,
        proposal.status,
        proposal.createdAt,
      );
    return proposal;
  }
  pending(dotId: string): Proposal | undefined {
    return this.db
      .prepare(
        "SELECT * FROM instruction_proposals WHERE dotId = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1",
      )
      .get(dotId) as Proposal | undefined;
  }
  proposal(id: string): Proposal | undefined {
    return this.db
      .prepare('SELECT * FROM instruction_proposals WHERE id = ?')
      .get(id) as Proposal | undefined;
  }
  resolve(id: string, status: 'applied' | 'dismissed') {
    this.db
      .prepare(
        "UPDATE instruction_proposals SET status = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, id);
  }
}
