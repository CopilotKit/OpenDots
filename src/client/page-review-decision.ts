import { pageReviewSchema, type PageReviewDraft } from '../shared/page-review';
import type { Page, ReviewedPage } from '../server/pages';
import { api } from './api';

const reviewPath = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}/reviewed-page`;

export type DeletedReview = {
  deleted: true;
  pageId: string;
  spaceId: string;
  reviewDraft: PageReviewDraft | null;
};
export const isDeletedReview = (value: unknown): value is DeletedReview =>
  !!value &&
  typeof value === 'object' &&
  (value as DeletedReview).deleted === true;

export function restorePageReview(threadId: string, toolCallId: string) {
  return api<ReviewedPage | DeletedReview | null>(
    `${reviewPath(threadId)}/${encodeURIComponent(toolCallId)}`,
  );
}

export function matchesReviewedDraft(
  page: { reviewDraft: PageReviewDraft | null },
  args: unknown,
) {
  // Receipts created before draft binding have no original snapshot.
  if (!page.reviewDraft) return true;
  const draft = pageReviewSchema.safeParse(args);
  return (
    draft.success &&
    draft.data.title === page.reviewDraft.title &&
    draft.data.content === page.reviewDraft.content &&
    draft.data.spaceId === page.reviewDraft.spaceId &&
    (draft.data.pageId ?? undefined) ===
      (page.reviewDraft.pageId ?? undefined) &&
    (draft.data.expectedRevision ?? undefined) ===
      (page.reviewDraft.expectedRevision ?? undefined)
  );
}

export async function decidePageReview(
  threadId: string,
  toolCallId: string,
  args: unknown,
  approved: boolean,
): Promise<ReviewedPage | DeletedReview | null> {
  // A previous save may have committed even if its response never arrived.
  const previous = await restorePageReview(threadId, toolCallId);
  if (previous) {
    if (!matchesReviewedDraft(previous, args))
      throw new Error(
        'This review was saved with a different draft. Start a new review for the changed draft.',
      );
    return previous;
  }
  if (!approved) return null;
  const draft = pageReviewSchema.parse(args);
  return api<ReviewedPage>(reviewPath(threadId), 'POST', {
    ...draft,
    toolCallId,
  });
}

export interface ReviewTarget {
  pageId: string;
  title: string;
  spaceId: string;
  spaceName: string | null;
}

// The approval card must identify which existing page an update would
// overwrite before the owner approves: identical drafts targeting
// different pages otherwise render identical cards.
export async function fetchReviewTarget(
  spaceId: string,
  pageId: string | null | undefined,
): Promise<ReviewTarget | null> {
  if (!pageId) return null;
  const page = await api<Page>(
    `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`,
  );
  const workspace = await api<{ spaces: { id: string; name: string }[] }>(
    '/workspace',
  ).catch(() => null);
  return {
    pageId: page.id,
    title: page.title,
    spaceId,
    spaceName:
      workspace?.spaces.find((space) => space.id === spaceId)?.name ?? null,
  };
}
