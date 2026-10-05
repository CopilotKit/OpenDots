import { pageReviewSchema } from '../shared/page-review';
import type { ReviewedPage } from '../server/pages';
import { api } from './api';

const reviewPath = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}/reviewed-page`;

export function restorePageReview(threadId: string, toolCallId: string) {
  return api<ReviewedPage | null>(
    `${reviewPath(threadId)}/${encodeURIComponent(toolCallId)}`,
  );
}

export function matchesReviewedDraft(page: ReviewedPage, args: unknown) {
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
): Promise<ReviewedPage | null> {
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
