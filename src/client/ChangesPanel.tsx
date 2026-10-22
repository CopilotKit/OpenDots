import { useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, XCircle } from 'lucide-react';
import { api } from './api';

interface Review {
  id: string;
  branch: string;
  title: string;
  summary: string;
  diff: string;
  checks: string;
  passed: boolean;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: number;
}

// Code changes submitted by the Developer Dot. Nothing reaches the running app
// until the owner clicks Apply (which merges the branch).
export function ChangesPanel() {
  const [reviews, setReviews] = useState<Review[]>();
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = () =>
    api<{ reviews: Review[] }>('/dev/reviews')
      .then((data) => setReviews(data.reviews))
      .catch(() => setNotice('Could not load code changes.'));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, []);
  const act = async (id: string, action: 'apply' | 'reject') => {
    setBusy(true);
    setNotice('');
    try {
      const result = await api<{ note?: string }>(
        `/dev/reviews/${id}/${action}`,
        'POST',
        {},
      );
      setNotice(
        action === 'apply'
          ? (result.note ?? 'Applied.')
          : 'Rejected; the branch was deleted.',
      );
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };
  if (!reviews) return <p className="computer-panel">Loading changes…</p>;
  const pending = reviews.filter((r) => r.status === 'pending');
  const past = reviews.filter((r) => r.status !== 'pending').slice(0, 10);
  return (
    <div className="changes-panel">
      {notice && <p className="config-note">{notice}</p>}
      {!pending.length && (
        <p className="muted">
          No code changes waiting. Ask the Developer Dot to fix or add
          something; its change appears here for your review.
        </p>
      )}
      {pending.map((review) => (
        <article className="change-card" key={review.id}>
          <header>
            <GitBranch size={15} />
            <strong>{review.title}</strong>
            <span className={`check-badge ${review.passed ? 'pass' : 'fail'}`}>
              {review.passed ? (
                <CheckCircle2 size={13} />
              ) : (
                <XCircle size={13} />
              )}
              {review.passed ? 'Checks pass' : 'Checks failed'}
            </span>
          </header>
          <p>{review.summary}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => setOpen(open === review.id ? undefined : review.id)}
          >
            {open === review.id ? 'Hide' : 'Show'} diff and check results
          </button>
          {open === review.id && (
            <>
              <pre className="change-checks">{review.checks}</pre>
              <pre className="change-diff">
                {review.diff.split('\n').map((line, index) => (
                  <span
                    key={index}
                    className={
                      line.startsWith('+') && !line.startsWith('+++')
                        ? 'add'
                        : line.startsWith('-') && !line.startsWith('---')
                          ? 'del'
                          : ''
                    }
                  >
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </>
          )}
          <div className="proposal-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !review.passed}
              onClick={() => {
                if (
                  window.confirm(
                    'Apply this code change to OpenDots? A restart is required to load it.',
                  )
                )
                  void act(review.id, 'apply');
              }}
            >
              Apply
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void act(review.id, 'reject')}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
      {past.length > 0 && (
        <section>
          <span className="eyebrow">EARLIER</span>
          {past.map((review) => (
            <p className="muted" key={review.id}>
              {review.status === 'applied' ? 'Applied' : 'Rejected'}:{' '}
              {review.title}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
