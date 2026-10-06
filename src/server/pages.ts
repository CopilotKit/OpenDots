import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  pageReviewSchema,
  type PageReviewDraft,
} from '../shared/page-review.js';
export const pageInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().max(100000).default(''),
    parentId: z.string().min(1).nullable().default(null),
  })
  .strict();
export const pagePatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(100000).optional(),
    parentId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
}
export type ReviewedPage = Page & {
  reviewDraft: PageReviewDraft | null;
};
export class PageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
export class Pages {
  constructor(
    private db: DatabaseSync,
    private spaceExists: (id: string) => boolean,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, draft TEXT, PRIMARY KEY(threadId,toolCallId))',
    );
    if (
      !db
        .prepare('PRAGMA table_info(page_reviews)')
        .all()
        .some((row) => row.name === 'draft')
    )
      db.exec('ALTER TABLE page_reviews ADD COLUMN draft TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, parentId TEXT, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sourceThreadId TEXT);
 CREATE TABLE IF NOT EXISTS page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId));`);
    if (
      !db
        .prepare('PRAGMA table_info(page_threads)')
        .all()
        .some((row) => row.name === 'leaseUntil')
    )
      db.exec(
        'ALTER TABLE page_threads ADD COLUMN leaseUntil INTEGER NOT NULL DEFAULT 0',
      );
  }
  requireSpace(spaceId: string) {
    if (!this.spaceExists(spaceId))
      throw new PageError('Space not found.', 404);
  }
  exists(spaceId: string, id: string): boolean {
    this.requireSpace(spaceId);
    return !!this.db
      .prepare('SELECT 1 FROM pages WHERE id=? AND spaceId=?')
      .get(id, spaceId);
  }
  list(spaceId: string): Page[] {
    this.requireSpace(spaceId);
    return this.db
      .prepare('SELECT * FROM pages WHERE spaceId=? ORDER BY createdAt,id')
      .all(spaceId) as unknown as Page[];
  }
  get(spaceId: string, id: string): Page {
    this.requireSpace(spaceId);
    const row = this.db
      .prepare('SELECT * FROM pages WHERE id=? AND spaceId=?')
      .get(id, spaceId);
    if (!row) throw new PageError('Page not found in this Space.', 404);
    return row as unknown as Page;
  }
  private parent(spaceId: string, parentId: string | null, id?: string) {
    const seen = new Set([id]);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor))
        throw new PageError(
          'A page cannot be moved into itself or a descendant.',
        );
      seen.add(cursor);
      cursor = this.get(spaceId, cursor).parentId;
    }
  }
  create(
    spaceId: string,
    input: z.input<typeof pageInput>,
    sourceThreadId: string | null = null,
  ): Page {
    this.requireSpace(spaceId);
    const parsed = pageInput.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'Pages require a title up to 160 characters and content up to 100,000 characters.',
      );
    const data = parsed.data;
    this.parent(spaceId, data.parentId);
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare('INSERT INTO pages VALUES (?,?,?,?,?,1,?,?,?)')
      .run(
        id,
        spaceId,
        data.parentId,
        data.title,
        data.content,
        now,
        now,
        sourceThreadId,
      );
    return this.get(spaceId, id);
  }
  reviewReceipt(
    threadId: string,
    toolCallId: string,
  ): { pageId: string; spaceId: string; draft: PageReviewDraft | null } | null {
    const row = this.db
      .prepare(
        'SELECT pageId,spaceId,draft FROM page_reviews WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    return row
      ? {
          pageId: String(row.pageId),
          spaceId: String(row.spaceId),
          draft: row.draft
            ? pageReviewSchema.parse(JSON.parse(String(row.draft)))
            : null,
        }
      : null;
  }
  createReviewed(
    spaceId: string,
    input: Pick<PageReviewDraft, 'title' | 'content'>,
    threadId: string,
    toolCallId: string,
  ): ReviewedPage {
    const draft = pageReviewSchema.parse({ ...input, spaceId });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.reviewReceipt(threadId, toolCallId);
      if (previous) {
        if (previous.spaceId !== spaceId)
          throw new PageError(
            'This review was already saved to another Space.',
            409,
          );
        if (
          previous.draft &&
          (previous.draft.title !== draft.title ||
            previous.draft.content !== draft.content)
        )
          throw new PageError(
            'This review was already saved with a different draft. Start a new review for the changed draft.',
            409,
          );
        const page = this.get(spaceId, previous.pageId);
        this.db.exec('COMMIT');
        return { ...page, reviewDraft: previous.draft };
      }
      const page = this.create(
        spaceId,
        { title: draft.title, content: draft.content },
        threadId,
      );
      this.db
        .prepare(
          'INSERT INTO page_reviews (threadId,toolCallId,pageId,spaceId,draft) VALUES (?,?,?,?,?)',
        )
        .run(threadId, toolCallId, page.id, spaceId, JSON.stringify(draft));
      this.db.exec('COMMIT');
      return { ...page, reviewDraft: draft };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  update(spaceId: string, id: string, input: z.input<typeof pagePatch>): Page {
    const parsed = pagePatch.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'A valid page patch and expectedRevision are required.',
      );
    const data = parsed.data;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const page = this.get(spaceId, id);
      if (page.revision !== data.expectedRevision)
        throw new PageError(
          'This page changed. Reload the latest revision before saving your draft.',
          409,
        );
      const parent =
        data.parentId === undefined ? page.parentId : data.parentId;
      this.parent(spaceId, parent, id);
      this.db
        .prepare(
          'UPDATE pages SET title=?,content=?,parentId=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=?',
        )
        .run(
          data.title ?? page.title,
          data.content ?? page.content,
          parent,
          Date.now(),
          id,
          data.expectedRevision,
        );
      this.db.exec('COMMIT');
      return this.get(spaceId, id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  thread(pageId: string, dotId: string) {
    const row = this.db
      .prepare(
        'SELECT threadId,ready FROM page_threads WHERE pageId=? AND dotId=?',
      )
      .get(pageId, dotId);
    return row
      ? { threadId: String(row.threadId), ready: !!row.ready }
      : undefined;
  }
  reserveThread(pageId: string, dotId: string, threadId: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO page_threads(pageId,dotId,threadId,ready,leaseUntil) VALUES(?,?,?,0,0)',
      )
      .run(pageId, dotId, threadId);
    return (
      this.db
        .prepare(
          'UPDATE page_threads SET leaseUntil=? WHERE pageId=? AND dotId=? AND ready=0 AND leaseUntil<=?',
        )
        .run(Date.now() + 60000, pageId, dotId, Date.now()).changes > 0
    );
  }
  finishThread(pageId: string, dotId: string) {
    this.db
      .prepare('UPDATE page_threads SET ready=1 WHERE pageId=? AND dotId=?')
      .run(pageId, dotId);
  }
  releaseThread(pageId: string, dotId: string) {
    this.db
      .prepare(
        'UPDATE page_threads SET leaseUntil=0 WHERE pageId=? AND dotId=? AND ready=0',
      )
      .run(pageId, dotId);
  }
  forThread(threadId: string, spaceId?: string): Page | undefined {
    const row = this.db
      .prepare(
        'SELECT pageId, pages.spaceId FROM page_threads JOIN pages ON pages.id=page_threads.pageId WHERE threadId=? AND ready=1',
      )
      .get(threadId);
    return row
      ? this.get(spaceId ?? String(row.spaceId), String(row.pageId))
      : undefined;
  }
  delete(spaceId: string, id: string): boolean {
    this.requireSpace(spaceId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const page = this.db
        .prepare('SELECT parentId FROM pages WHERE id=? AND spaceId=?')
        .get(id, spaceId) as { parentId: string | null } | undefined;
      if (!page) {
        this.db.exec('COMMIT');
        return false;
      }
      const now = Date.now();
      this.db
        .prepare(
          'UPDATE pages SET parentId=?, revision=revision+1, updatedAt=? WHERE spaceId=? AND parentId=?',
        )
        .run(page.parentId, now, spaceId, id);
      // page_reviews rows stay: a retried approval must not recreate this page.
      this.db.prepare('DELETE FROM page_threads WHERE pageId=?').run(id);
      this.db
        .prepare('DELETE FROM pages WHERE id=? AND spaceId=?')
        .run(id, spaceId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
