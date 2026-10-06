import { useEffect, useRef, useState } from 'react';
import { Check, FileText, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { pageReviewSchema } from '../shared/page-review';
import {
  decidePageReview,
  fetchReviewTarget,
  isDeletedReview,
  matchesReviewedDraft,
  restorePageReview,
  type DeletedReview,
} from './page-review-decision';
import type { ReviewTarget } from './page-review-decision';
import { openPageLink } from './page-navigation';
import type { ReviewedPage } from '../server/pages';
export function approveLabel(isUpdate: boolean) {
  return isUpdate ? 'Approve & update page' : 'Approve & create page';
}

export function PageReviewCard({
  args,
  status,
  respond,
  threadId,
  toolCallId,
  onSaved,
}: {
  args: unknown;
  status: string;
  result?: unknown;
  respond?: (result: unknown) => Promise<void>;
  threadId: string;
  toolCallId: string;
  onSaved: () => void;
}) {
  const draft = pageReviewSchema.safeParse(args);
  const [savedPage, setSavedPage] = useState<ReviewedPage>();
  const [deletedReview, setDeletedReview] = useState<DeletedReview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiptReady, setReceiptReady] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [targetStatus, setTargetStatus] = useState<
    'idle' | 'pending' | 'identified' | 'failed'
  >('idle');
  const [targetLookupAttempt, setTargetLookupAttempt] = useState(0);
  const pending = useRef(false);
  const finished = status === 'complete';
  const reviewed = savedPage ?? deletedReview;
  const conflict = !!reviewed && !matchesReviewedDraft(reviewed, args);
  const removed = !!deletedReview && !conflict;
  const saved = (!!savedPage || removed) && !conflict;
  const pageId = savedPage?.id ?? '';
  const spaceId = savedPage?.spaceId ?? '';
  const targetPageId = draft.success ? (draft.data.pageId ?? null) : null;
  const targetSpaceId = draft.success ? draft.data.spaceId : null;
  // An update approval is only allowed once the page it would overwrite has
  // been identified; a pending or failed lookup must not leave an enabled
  // approve button behind an unidentified "Updates an existing page." card.
  const targetGated = !!targetPageId && targetStatus !== 'identified';
  useEffect(() => {
    if (!targetPageId || !targetSpaceId) {
      setTarget(null);
      setTargetStatus('idle');
      return;
    }
    let active = true;
    setTarget(null);
    setTargetStatus('pending');
    void fetchReviewTarget(targetSpaceId, targetPageId)
      .then((found) => {
        if (!active) return;
        setTarget(found);
        setTargetStatus(found ? 'identified' : 'failed');
      })
      .catch(() => {
        if (!active) return;
        setTarget(null);
        setTargetStatus('failed');
      });
    return () => {
      active = false;
    };
  }, [targetPageId, targetSpaceId, targetLookupAttempt]);
  useEffect(() => {
    let active = true;
    setReceiptReady(false);
    setSavedPage(undefined);
    setDeletedReview(undefined);
    setError('');
    void restorePageReview(threadId, toolCallId)
      .then((page) => {
        if (!active) return;
        if (isDeletedReview(page)) setDeletedReview(page);
        else setSavedPage(page ?? undefined);
        setReceiptReady(true);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not restore this review.',
          );
      });
    return () => {
      active = false;
    };
  }, [threadId, toolCallId, restoreAttempt]);
  const decide = async (approved: boolean) => {
    if (!respond || !receiptReady || conflict || pending.current) return;
    // Continuing an already-saved review stays independent of the target
    // lookup; only a new update approval is gated on identification.
    if (approved && !saved && targetGated) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const page = await decidePageReview(threadId, toolCallId, args, approved);
      if (!page) {
        await respond({
          approved: false,
          message: 'The owner declined this draft. Do not save it.',
        });
        return;
      }
      if (isDeletedReview(page)) {
        setSavedPage(undefined);
        setDeletedReview(page);
        await respond({
          approved: true,
          pageId: page.pageId,
          spaceId: page.spaceId,
          deleted: true,
          message:
            'The draft was saved, then the owner deleted the page. Do not link it.',
        });
        return;
      }
      setSavedPage(page);
      onSaved();
      await respond({
        approved: true,
        pageId: page.id,
        spaceId: page.spaceId,
        url: `/#/spaces/${page.spaceId}/pages/${page.id}`,
      });
    } catch (cause) {
      setReceiptReady(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save the approved draft.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="page-review-card" aria-label="Review page draft">
      <header>
        <FileText size={17} />
        <strong>
          {conflict
            ? 'Review changed'
            : removed
              ? 'Saved, then deleted'
              : saved
                ? 'Saved to your Space'
                : !receiptReady
                  ? 'Checking saved review…'
                  : finished
                    ? 'Review ended'
                    : 'Ready for your review'}
        </strong>
        <span>
          {conflict
            ? 'Needs new review'
            : saved
              ? 'Approved'
              : !receiptReady
                ? 'Checking'
                : finished
                  ? 'Not saved'
                  : 'You decide'}
        </span>
      </header>
      <div className="page-review-body">
        {targetPageId && (
          <p className="page-review-target">
            {targetStatus === 'identified' && target
              ? `Updates existing page "${target.title}"${
                  target.spaceName ? ` in ${target.spaceName}` : ''
                }.`
              : targetStatus === 'failed'
                ? 'Could not identify the page this would update.'
                : 'Identifying the page this would update…'}
          </p>
        )}
        <h3>{draft.success ? draft.data.title : 'Preparing your draft…'}</h3>
        {draft.success && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {draft.data.content}
          </ReactMarkdown>
        )}
      </div>
      {conflict && (
        <p role="alert">
          This review was saved with a different draft. Start a new review for
          the changed draft.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {targetPageId && targetStatus === 'failed' && !saved && (
        <button
          type="button"
          onClick={() => setTargetLookupAttempt((attempt) => attempt + 1)}
        >
          Retry target lookup
        </button>
      )}
      {!receiptReady && error && (
        <button
          type="button"
          onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
        >
          Retry review
        </button>
      )}
      <footer>
        {(saved || conflict) && pageId && spaceId && (
          <button
            type="button"
            className="review-primary"
            onClick={() =>
              openPageLink(
                `/#/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`,
              )
            }
          >
            {conflict ? 'Open saved page' : 'Open page'}{' '}
            <ArrowUpRight size={15} />
          </button>
        )}
        {!finished && respond && receiptReady && !conflict && (
          <>
            <button
              type="button"
              disabled={busy || (!saved && (!draft.success || targetGated))}
              className="review-primary"
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy
                ? 'Saving…'
                : saved
                  ? 'Continue conversation'
                  : approveLabel(!!targetPageId)}
            </button>
            {!saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Decline
              </button>
            )}
          </>
        )}
        {!saved && !conflict && (
          <small>
            {!receiptReady
              ? 'Checking whether this draft was already saved.'
              : finished
                ? 'No page was saved.'
                : 'Nothing is saved until you approve.'}
          </small>
        )}
      </footer>
    </section>
  );
}
