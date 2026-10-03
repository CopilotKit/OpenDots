import { useEffect, useRef, useState } from 'react';
import { Check, PlugZap } from 'lucide-react';
import {
  connectionActionSchema,
  type ConnectionActionResult,
} from '../shared/connection-types';
import { api } from './api';
import { computerToolResult } from './ComputerToolCard';
type Receipt = {
  status: 'running' | 'done';
  result: ConnectionActionResult | null;
};
const actions = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}/connection-actions`;
const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function ConnectionActionCard({
  args,
  status,
  result,
  respond,
  threadId,
  toolCallId,
}: {
  args: unknown;
  status: string;
  result?: unknown;
  respond?: (result: unknown) => Promise<void>;
  threadId: string;
  toolCallId: string;
}) {
  const action = connectionActionSchema.safeParse(args);
  const recorded = computerToolResult(result);
  const [label, setLabel] = useState<{ connection: string; title: string }>();
  const [receipt, setReceipt] = useState<Receipt | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const finished = status === 'complete';
  const tool = action.success ? action.data.tool : '';
  useEffect(() => {
    if (!tool) return;
    let active = true;
    void api<{ connection: string; title: string }>(
      `/conversations/${encodeURIComponent(threadId)}/connection-tools/${encodeURIComponent(tool)}`,
    )
      .then((value) => active && setLabel(value))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [threadId, tool]);
  useEffect(() => {
    let active = true;
    setError('');
    void api<Receipt | null>(
      `${actions(threadId)}/${encodeURIComponent(toolCallId)}`,
    )
      .then((value) => active && setReceipt(value))
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not check this action.',
          );
      });
    return () => {
      active = false;
    };
  }, [threadId, toolCallId, attempt]);
  const outcome = receipt?.result ?? null;
  const approved = recorded.approved === true || receipt?.status === 'done';
  const declined = recorded.approved === false;
  const ready = receipt !== undefined;
  const decide = async (approve: boolean) => {
    if (!respond || !action.success || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (!approve && !outcome) {
        await respond({
          approved: false,
          message:
            'The owner declined this action. Do not perform it or try another way.',
        });
        return;
      }
      // A previous approval may have run even if its response never arrived.
      const value =
        outcome ??
        (await api<ConnectionActionResult>(actions(threadId), 'POST', {
          toolCallId,
          tool: action.data.tool,
          arguments: action.data.arguments,
        }));
      setReceipt({ status: 'done', result: value });
      await respond({ approved: true, ...value });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not run this action.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const entries = action.success ? Object.entries(action.data.arguments) : [];
  return (
    <section
      className="page-review-card connection-action-card"
      aria-label="Approve connected-service action"
    >
      <header>
        <PlugZap size={17} />
        <strong>
          {label ? `${label.connection} · ${label.title}` : tool || 'Action'}
        </strong>
        <span>
          {approved
            ? outcome?.isError
              ? 'Failed'
              : 'Approved'
            : declined
              ? 'Declined'
              : finished
                ? 'Ended'
                : !ready
                  ? 'Checking'
                  : 'Needs your approval'}
        </span>
      </header>
      <div className="page-review-body">
        <h3>
          {action.success ? action.data.summary : 'Preparing the action…'}
        </h3>
        {entries.length > 0 && (
          <dl className="connection-action-args">
            {entries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{display(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {outcome && (
          <div
            className={`connection-action-result ${outcome.isError ? 'failed' : ''}`}
          >
            <strong>
              {outcome.isError ? 'Service error' : 'Service response'}
            </strong>
            <pre>{outcome.text}</pre>
          </div>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer>
        {!ready && error && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        )}
        {!finished && respond && ready && receipt?.status !== 'running' && (
          <>
            <button
              type="button"
              className="review-primary"
              disabled={busy || !action.success}
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy
                ? 'Running…'
                : outcome
                  ? 'Continue conversation'
                  : 'Approve & run'}
            </button>
            {!outcome && (
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
        <small>
          {receipt?.status === 'running'
            ? 'This action is still running on the server.'
            : approved || declined || finished
              ? ''
              : 'Nothing runs until you approve.'}
        </small>
      </footer>
    </section>
  );
}
