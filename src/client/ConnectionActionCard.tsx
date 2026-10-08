import { useEffect, useRef, useState } from 'react';
import { Check, PlugZap } from 'lucide-react';
import {
  connectionActionSchema,
  type ConnectionActionResult,
  type PendingApproval,
} from '../shared/connection-types';
import { api } from './api';
import { t } from './i18n';
import { computerToolResult } from './ComputerToolCard';
type Receipt = {
  approvalId: string | null;
  status: 'running' | 'done';
  result: ConnectionActionResult | null;
};
const conversation = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}`;
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
  const [approval, setApproval] = useState<PendingApproval>();
  const [approvalError, setApprovalError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const finished = status === 'complete';
  const approvalId = action.success ? action.data.approvalId : '';
  // Show the server's record of what will run, not the model's description.
  useEffect(() => {
    if (!approvalId) return;
    let active = true;
    setApprovalError('');
    void api<PendingApproval>(
      `${conversation(threadId)}/connection-approvals/${encodeURIComponent(approvalId)}`,
    )
      .then((value) => active && setApproval(value))
      .catch(
        (cause) =>
          active &&
          setApprovalError(
            cause instanceof Error
              ? cause.message
              : t('connectedAction.loadError'),
          ),
      );
    return () => {
      active = false;
    };
  }, [threadId, approvalId]);
  // A saved result counts only if it came from this card's approval.
  const mismatch = !!receipt && receipt.approvalId !== approvalId;
  const own = mismatch ? null : receipt;
  // A receipt that is still running is checked until the server finishes.
  const running = own?.status === 'running';
  useEffect(() => {
    let active = true;
    const load = () =>
      api<Receipt | null>(
        `${conversation(threadId)}/connection-actions/${encodeURIComponent(toolCallId)}`,
      )
        .then((value) => active && setReceipt(value))
        .catch((cause) => {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : t('connectedAction.checkError'),
            );
        });
    setError('');
    void load();
    const timer = running ? setInterval(() => void load(), 2000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [threadId, toolCallId, attempt, running]);
  const outcome = own?.result ?? null;
  const approved = recorded.approved === true || own?.status === 'done';
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
        (await api<ConnectionActionResult>(
          `${conversation(threadId)}/connection-actions`,
          'POST',
          { toolCallId, approvalId: action.data.approvalId },
        ));
      setReceipt({ approvalId, status: 'done', result: value });
      await respond({ approved: true, ...value });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('connectedAction.runError'),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const entries = approval ? Object.entries(approval.arguments) : [];
  return (
    <section
      className="page-review-card connection-action-card"
      aria-label={t('connectedAction.approveAction')}
    >
      <header>
        <PlugZap size={17} />
        <strong>
          {approval
            ? `${approval.connection} · ${approval.title}`
            : t('connectedAction.service')}
        </strong>
        <span>
          {approved
            ? outcome?.isError
              ? t('connectedAction.failed')
              : t('connectedAction.approved')
            : declined
              ? t('connectedAction.declined')
              : running
                ? t('connectedAction.running')
                : finished
                  ? t('connectedAction.ended')
                  : !ready
                    ? t('connectedAction.checking')
                    : t('connectedAction.needsApproval')}
        </span>
      </header>
      <div className="page-review-body">
        <h3>
          {action.success
            ? action.data.summary
            : t('connectedAction.preparing')}
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
        {mismatch && (
          <div className="connection-action-result failed">
            <strong>{t('connectedAction.cannotRun')}</strong>
            <pre>{t('connectedAction.mismatch')}</pre>
          </div>
        )}
        {approvalError && !outcome && (
          <div className="connection-action-result failed">
            <strong>{t('connectedAction.cannotRun')}</strong>
            <pre>{approvalError}</pre>
          </div>
        )}
        {outcome && (
          <div
            className={`connection-action-result ${outcome.isError ? 'failed' : ''}`}
          >
            <strong>
              {outcome.isError
                ? t('connectedAction.serviceError')
                : t('connectedAction.serviceResponse')}
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
        {!finished && respond && ready && !running && !mismatch && (
          <>
            <button
              type="button"
              className="review-primary"
              disabled={busy || !action.success || (!outcome && !approval)}
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy
                ? t('connectedAction.runningNow')
                : outcome
                  ? t('connectedAction.continue')
                  : t('connectedAction.approveRun')}
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
          {running
            ? t('connectedAction.stillRunning')
            : approved || declined || finished
              ? ''
              : t('connectedAction.approvalDetails')}
        </small>
      </footer>
    </section>
  );
}
