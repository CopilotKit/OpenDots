import { useEffect, useRef, useState } from 'react';
import { Check, FileText, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { pageReviewSchema } from '../shared/page-review';
import {
  decidePageReview,
  isDeletedReview,
  matchesReviewedDraft,
  restorePageReview,
  type DeletedReview,
} from './page-review-decision';
import { openPageLink } from './page-navigation';
import type { ReviewedPage } from '../server/pages';
import { t } from './i18n';
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
  const pending = useRef(false);
  const finished = status === 'complete';
  const reviewed = savedPage ?? deletedReview;
  const conflict = !!reviewed && !matchesReviewedDraft(reviewed, args);
  const removed = !!deletedReview && !conflict;
  const saved = (!!savedPage || removed) && !conflict;
  const pageId = savedPage?.id ?? '';
  const spaceId = savedPage?.spaceId ?? '';
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
              : t('Could not restore this review.'),
          );
      });
    return () => {
      active = false;
    };
  }, [threadId, toolCallId, restoreAttempt]);
  const decide = async (approved: boolean) => {
    if (!respond || !receiptReady || conflict || pending.current) return;
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
          : t('Could not save the approved draft.'),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="page-review-card" aria-label={t('Review page draft')}>
      <header>
        <FileText size={17} />
        <strong>
          {conflict
            ? t('Review changed')
            : removed
              ? t('Saved, then deleted')
              : saved
                ? t('Saved to your Space')
                : !receiptReady
                  ? t('Checking saved review…')
                  : finished
                    ? t('Review ended')
                    : t('Ready for your review')}
        </strong>
        <span>
          {conflict
            ? t('Needs new review')
            : saved
              ? t('Approved')
              : !receiptReady
                ? t('Checking')
                : finished
                  ? t('Not saved')
                  : t('You decide')}
        </span>
      </header>
      <div className="page-review-body">
        <h3>{draft.success ? draft.data.title : t('Preparing your draft…')}</h3>
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
          {t(
            'This review was saved with a different draft. Start a new review for the changed draft.',
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!receiptReady && error && (
        <button
          type="button"
          onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
        >
          {t('Retry review')}
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
            {conflict ? t('Open saved page') : t('Open page')}{' '}
            <ArrowUpRight size={15} />
          </button>
        )}
        {!finished && respond && receiptReady && !conflict && (
          <>
            <button
              type="button"
              disabled={busy || (!saved && !draft.success)}
              className="review-primary"
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy
                ? t('Saving…')
                : saved
                  ? t('Continue conversation')
                  : t('Approve & save')}
            </button>
            {!saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                {t('Decline')}
              </button>
            )}
          </>
        )}
        {!saved && !conflict && (
          <small>
            {!receiptReady
              ? t('Checking whether this draft was already saved.')
              : finished
                ? t('No page was saved.')
                : t('Nothing is saved until you approve.')}
          </small>
        )}
      </footer>
    </section>
  );
}
