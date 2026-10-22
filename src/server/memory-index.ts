import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Message } from '@ag-ui/client';

// Long-term memory: past conversations and indexed folders are embedded with a
// local Ollama embedding model and searched by cosine similarity. All local.
const textFiles = new Set(
  '.md .txt .log .csv .json .yaml .yml .ini .toml .xml .html .py .ts .tsx .js .jsx .cs .cpp .c .h .hpp .java .go .rs .ps1 .sh .bat .sql .lua .gd .uplugin .uproject'.split(
    ' ',
  ),
);
const skipDirs = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'Binaries',
  'Intermediate',
  'DerivedDataCache',
  'Saved',
]);

export interface MemoryHit {
  source: 'conversation' | 'file';
  ref: string;
  text: string;
  score: number;
}

export function chunk(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += size - overlap)
    chunks.push(clean.slice(start, start + size));
  return chunks;
}

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

export class MemoryIndex {
  private db: DatabaseSync;
  constructor(
    path: string,
    private embedUrl: string,
    private model = 'nomic-embed-text',
    private embedder?: (texts: string[]) => Promise<number[][]>,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memory_chunks(id TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_ref ON memory_chunks(ref);
      CREATE TABLE IF NOT EXISTS memory_files(path TEXT PRIMARY KEY, mtime INTEGER NOT NULL);`);
  }
  /** Embeds texts with the local embedding model (also used by skills). */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.embedder)
      return (await this.embedder(texts)).map((v) => Float32Array.from(v));
    const response = await fetch(`${this.embedUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(
        `Embedding model unavailable (HTTP ${response.status}). Run: ollama pull ${this.model}`,
      );
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings.map((v) => Float32Array.from(v));
  }
  private async store(
    source: MemoryHit['source'],
    items: { id: string; ref: string; text: string }[],
  ) {
    const fresh = items.filter(
      (item) =>
        !this.db.prepare('SELECT 1 FROM memory_chunks WHERE id=?').get(item.id),
    );
    for (let i = 0; i < fresh.length; i += 32) {
      const batch = fresh.slice(i, i + 32);
      const vectors = await this.embed(batch.map((item) => item.text));
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO memory_chunks VALUES (?, ?, ?, ?, ?, ?)',
      );
      batch.forEach((item, index) =>
        insert.run(
          item.id,
          source,
          item.ref,
          item.text,
          new Uint8Array(vectors[index].buffer),
          Date.now(),
        ),
      );
    }
    return fresh.length;
  }
  /** Index new user/assistant messages of a conversation (idempotent by id). */
  async indexConversation(
    threadId: string,
    title: string,
    messages: Message[],
  ) {
    const items = messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const text = typeof message.content === 'string' ? message.content : '';
      return chunk(text).map((part, index) => ({
        id: `msg:${message.id}:${index}`,
        ref: `conversation:${threadId}`,
        text: `[${title}] ${message.role}: ${part}`,
      }));
    });
    return this.store('conversation', items);
  }
  /** Index text files in a folder, re-embedding only changed files. */
  async indexFolder(root: string, limit = 2000) {
    let files = 0,
      chunks = 0;
    const walk = async (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (files >= limit) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith('.'))
            await walk(path);
          continue;
        }
        if (!textFiles.has(extname(entry.name).toLowerCase())) continue;
        const stat = statSync(path);
        if (stat.size > 1_000_000) continue;
        const mtime = Math.floor(stat.mtimeMs);
        const known = this.db
          .prepare('SELECT mtime FROM memory_files WHERE path=?')
          .get(path);
        if (known && Number(known.mtime) === mtime) continue;
        this.db.prepare('DELETE FROM memory_chunks WHERE ref=?').run(path);
        chunks += await this.store(
          'file',
          chunk(readFileSync(path, 'utf8')).map((text, index) => ({
            id: `file:${path}:${mtime}:${index}`,
            ref: path,
            text: `[${entry.name}] ${text}`,
          })),
        );
        this.db
          .prepare('INSERT OR REPLACE INTO memory_files VALUES (?, ?)')
          .run(path, mtime);
        files++;
      }
    };
    await walk(root);
    return { files, chunks };
  }
  async search(
    query: string,
    limit = 6,
    excludedRefs: ReadonlySet<string> = new Set(),
  ): Promise<MemoryHit[]> {
    const [vector] = await this.embed([query]);
    const rows = this.db
      .prepare('SELECT source, ref, text, embedding FROM memory_chunks')
      .all() as {
      source: MemoryHit['source'];
      ref: string;
      text: string;
      embedding: Uint8Array;
    }[];
    return rows
      .filter((row) => !excludedRefs.has(row.ref))
      .map((row) => ({
        source: row.source,
        ref: row.ref,
        text: row.text,
        score: cosine(
          vector,
          new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          ),
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => ({ ...hit, score: Math.round(hit.score * 1000) / 1000 }));
  }
  count() {
    return Number(
      this.db.prepare('SELECT count(*) AS n FROM memory_chunks').get()?.n ?? 0,
    );
  }
}
