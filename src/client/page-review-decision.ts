import { pageReviewSchema, type PageReviewDraft } from '../shared/page-review';
import type { ReviewedPage } from '../server/pages';
import { t } from './i18n';
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
    draft.data.spaceId === page.reviewDraft.spaceId
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
      throw new Error(t('review.changedDraft'));
    return previous;
  }
  if (!approved) return null;
  const draft = pageReviewSchema.parse(args);
  return api<ReviewedPage>(reviewPath(threadId), 'POST', {
    ...draft,
    toolCallId,
  });
}
