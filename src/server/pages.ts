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
export const pageVersionRestoreInput = z
  .object({
    versionId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const pageImportInput = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200).optional(),
            title: z.string().trim().min(1).max(160),
            content: z.string().max(100000).default(''),
            parentId: z.string().min(1).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(200),
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
  deletedAt?: number | null;
}

export interface PageVersion {
  id: string;
  pageId: string;
  spaceId: string;
  revision: number;
  title: string;
  content: string;
  createdAt: number;
  reason: string;
}

const MAX_VERSIONS_PER_PAGE = 50;
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
 CREATE TABLE IF NOT EXISTS page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId));
 CREATE TABLE IF NOT EXISTS page_versions(id TEXT PRIMARY KEY, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL, reason TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(pageId, createdAt DESC);`);
    if (
      !db
        .prepare('PRAGMA table_info(pages)')
        .all()
        .some((row) => row.name === 'deletedAt')
    )
      db.exec('ALTER TABLE pages ADD COLUMN deletedAt INTEGER');
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
      .prepare(
        'SELECT 1 FROM pages WHERE id=? AND spaceId=? AND deletedAt IS NULL',
      )
      .get(id, spaceId);
  }
  list(spaceId: string): Page[] {
    this.requireSpace(spaceId);
    return this.db
      .prepare(
        'SELECT * FROM pages WHERE spaceId=? AND deletedAt IS NULL ORDER BY createdAt,id',
      )
      .all(spaceId) as unknown as Page[];
  }
  get(spaceId: string, id: string): Page {
    this.requireSpace(spaceId);
    const row = this.db
      .prepare(
        'SELECT * FROM pages WHERE id=? AND spaceId=? AND deletedAt IS NULL',
      )
      .get(id, spaceId);
    if (!row) throw new PageError('Page not found in this Space.', 404);
    return row as unknown as Page;
  }
  private getIncludingDeleted(spaceId: string, id: string): Page {
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
      .prepare(
        'INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, deletedAt) VALUES (?,?,?,?,?,1,?,?,?,NULL)',
      )
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
      const nextTitle = data.title ?? page.title;
      const nextContent = data.content ?? page.content;
      const nextParent = parent;
      const contentChanged =
        nextTitle !== page.title ||
        nextContent !== page.content ||
        nextParent !== page.parentId;
      if (contentChanged) this.snapshot(page, 'edit');
      this.db
        .prepare(
          'UPDATE pages SET title=?,content=?,parentId=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=? AND deletedAt IS NULL',
        )
        .run(
          nextTitle,
          nextContent,
          nextParent,
          Date.now(),
          id,
          data.expectedRevision,
        );
      if (contentChanged) this.pruneVersions(id);
      this.db.exec('COMMIT');
      return this.get(spaceId, id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private snapshot(page: Page, reason: string) {
    this.db
      .prepare(
        'INSERT INTO page_versions(id, pageId, spaceId, revision, title, content, createdAt, reason) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        page.id,
        page.spaceId,
        page.revision,
        page.title,
        page.content,
        Date.now(),
        reason,
      );
  }

  private pruneVersions(pageId: string) {
    this.db
      .prepare(
        'DELETE FROM page_versions WHERE pageId=? AND id NOT IN (SELECT id FROM page_versions WHERE pageId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?)',
      )
      .run(pageId, pageId, MAX_VERSIONS_PER_PAGE);
  }

  versions(spaceId: string, pageId: string): PageVersion[] {
    this.get(spaceId, pageId);
    return this.db
      .prepare(
        'SELECT * FROM page_versions WHERE spaceId=? AND pageId=? ORDER BY revision DESC, createdAt DESC',
      )
      .all(spaceId, pageId) as unknown as PageVersion[];
  }

  restoreVersion(
    spaceId: string,
    pageId: string,
    input: z.input<typeof pageVersionRestoreInput>,
  ): Page {
    const parsed = pageVersionRestoreInput.safeParse(input);
    if (!parsed.success)
      throw new PageError('A valid version and expectedRevision are required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const page = this.get(spaceId, pageId);
      if (page.revision !== parsed.data.expectedRevision)
        throw new PageError(
          'This page changed. Reload the latest revision before restoring.',
          409,
        );
      const version = this.db
        .prepare(
          'SELECT * FROM page_versions WHERE id=? AND pageId=? AND spaceId=?',
        )
        .get(parsed.data.versionId, pageId, spaceId) as unknown | undefined;
      if (!version)
        throw new PageError(
          'That version is not available for this page.',
          404,
        );
      const snapshot = version as PageVersion;
      this.snapshot(page, 'restore');
      this.db
        .prepare(
          'UPDATE pages SET title=?,content=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=? AND deletedAt IS NULL',
        )
        .run(
          snapshot.title,
          snapshot.content,
          Date.now(),
          pageId,
          parsed.data.expectedRevision,
        );
      this.pruneVersions(pageId);
      this.db.exec('COMMIT');
      return this.get(spaceId, pageId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  trash(spaceId: string): Page[] {
    this.requireSpace(spaceId);
    return this.db
      .prepare(
        'SELECT * FROM pages WHERE spaceId=? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC, updatedAt DESC',
      )
      .all(spaceId) as unknown as Page[];
  }

  restoreDeleted(spaceId: string, id: string): Page {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const page = this.getIncludingDeleted(spaceId, id);
      if (page.deletedAt === null || page.deletedAt === undefined) {
        this.db.exec('COMMIT');
        return page;
      }
      let parentId = page.parentId;
      if (parentId) {
        const parent = this.db
          .prepare(
            'SELECT id FROM pages WHERE id=? AND spaceId=? AND deletedAt IS NULL',
          )
          .get(parentId, spaceId);
        if (!parent) parentId = null;
        else {
          // Guard against restoring under one of its own (deleted) descendants.
          const descendants = new Set<string>([id]);
          let cursor: string | null = parentId;
          let depth = 0;
          while (cursor && depth < 500) {
            if (descendants.has(cursor)) {
              parentId = null;
              break;
            }
            descendants.add(cursor);
            const row = this.db
              .prepare('SELECT parentId FROM pages WHERE id=? AND spaceId=?')
              .get(cursor, spaceId) as { parentId: string | null } | undefined;
            cursor = row?.parentId ?? null;
            depth += 1;
          }
        }
      }
      this.db
        .prepare(
          'UPDATE pages SET parentId=?, deletedAt=NULL, revision=revision+1, updatedAt=? WHERE id=? AND spaceId=?',
        )
        .run(parentId, Date.now(), id, spaceId);
      this.db.exec('COMMIT');
      return this.get(spaceId, id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  purge(spaceId: string, id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT id FROM pages WHERE id=? AND spaceId=?')
        .get(id, spaceId);
      if (!row) {
        this.db.exec('COMMIT');
        return false;
      }
      this.db.prepare('DELETE FROM page_threads WHERE pageId=?').run(id);
      this.db.prepare('DELETE FROM page_versions WHERE pageId=?').run(id);
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

  exportSpace(spaceId: string): {
    version: number;
    exportedAt: number;
    spaceId: string;
    pages: Pick<
      Page,
      | 'id'
      | 'parentId'
      | 'title'
      | 'content'
      | 'revision'
      | 'createdAt'
      | 'updatedAt'
    >[];
  } {
    this.requireSpace(spaceId);
    const pages = this.list(spaceId).map((page) => ({
      id: page.id,
      parentId: page.parentId,
      title: page.title,
      content: page.content,
      revision: page.revision,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    }));
    return { version: 1, exportedAt: Date.now(), spaceId, pages };
  }

  importSpace(spaceId: string, input: z.input<typeof pageImportInput>): Page[] {
    const parsed = pageImportInput.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'Import requires 1 to 200 pages with a title up to 160 characters and content up to 100,000 characters.',
      );
    this.requireSpace(spaceId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Remap old export ids (and positional "0"/"1" aliases for hand-written
      // payloads) to fresh ids so hierarchy survives a backup round-trip.
      const now = Date.now();
      const staged = parsed.data.pages.map((entry, index) => ({
        id: randomUUID(),
        entry,
        index,
        createdAt: now + index,
      }));
      const oldToNew = new Map<string, string>();
      for (const item of staged) {
        if (item.entry.id) oldToNew.set(item.entry.id, item.id);
        oldToNew.set(String(item.index), item.id);
      }
      const pendingParent = new Map<string, string | null>();
      for (const item of staged) {
        const rawParent = item.entry.parentId;
        let parentId: string | null = null;
        if (rawParent) parentId = oldToNew.get(rawParent) ?? null;
        pendingParent.set(item.id, parentId);
      }
      for (const item of staged) {
        this.db
          .prepare(
            'INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, deletedAt) VALUES (?,?,?,?,?,1,?,?,NULL,NULL)',
          )
          .run(
            item.id,
            spaceId,
            pendingParent.get(item.id) ?? null,
            item.entry.title,
            item.entry.content,
            item.createdAt,
            item.createdAt,
          );
      }
      // Validate hierarchy after insert: no cycles, parents in-space.
      const rows = this.db
        .prepare(
          'SELECT id, parentId FROM pages WHERE spaceId=? AND deletedAt IS NULL',
        )
        .all(spaceId) as { id: string; parentId: string | null }[];
      const byId = new Map(rows.map((row) => [row.id, row.parentId]));
      for (const item of staged) {
        const seen = new Set<string>([item.id]);
        let cursor = byId.get(item.id);
        while (cursor) {
          if (seen.has(cursor))
            throw new PageError('Imported pages cannot form a parent cycle.');
          seen.add(cursor);
          cursor = byId.get(cursor) ?? null;
        }
      }
      this.db.exec('COMMIT');
      return staged.map((item) => this.get(spaceId, item.id));
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
        .prepare(
          'SELECT parentId, deletedAt FROM pages WHERE id=? AND spaceId=?',
        )
        .get(id, spaceId) as
        { parentId: string | null; deletedAt: number | null } | undefined;
      if (!page || page.deletedAt != null) {
        this.db.exec('COMMIT');
        return false;
      }
      const now = Date.now();
      this.db
        .prepare(
          'UPDATE pages SET parentId=?, revision=revision+1, updatedAt=? WHERE spaceId=? AND parentId=? AND deletedAt IS NULL',
        )
        .run(page.parentId, now, spaceId, id);
      // page_reviews rows stay: a retried approval must not recreate this page.
      this.db.prepare('DELETE FROM page_threads WHERE pageId=?').run(id);
      this.db
        .prepare(
          'UPDATE pages SET deletedAt=?, revision=revision+1, updatedAt=? WHERE id=? AND spaceId=?',
        )
        .run(now, now, id, spaceId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
