import { pageReviewSchema } from '../shared/page-review';
import type { Page } from '../server/pages';
import { api } from './api';

const reviewPath = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}/reviewed-page`;

export type DeletedReview = { deleted: true; pageId: string; spaceId: string };
export const isDeletedReview = (value: unknown): value is DeletedReview =>
  !!value &&
  typeof value === 'object' &&
  (value as DeletedReview).deleted === true;

export function restorePageReview(threadId: string, toolCallId: string) {
  return api<Page | DeletedReview | null>(
    `${reviewPath(threadId)}/${encodeURIComponent(toolCallId)}`,
  );
}

export async function decidePageReview(
  threadId: string,
  toolCallId: string,
  args: unknown,
  approved: boolean,
): Promise<Page | DeletedReview | null> {
  // A previous save may have committed even if its response never arrived.
  const previous = await restorePageReview(threadId, toolCallId);
  if (previous) return previous;
  if (!approved) return null;
  const draft = pageReviewSchema.parse(args);
  return api<Page>(reviewPath(threadId), 'POST', { ...draft, toolCallId });
}
