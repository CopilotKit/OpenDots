import { useEffect, useRef, useState } from 'react';
import { Check, Terminal } from 'lucide-react';
import {
  hostShellActionSchema,
  type HostShellActionResult,
  type PendingHostShellApproval,
} from '../shared/host-shell-types';
import { api } from './api';
import { computerToolResult } from './ComputerToolCard';

type Receipt = {
  approvalId: string | null;
  status: 'running' | 'done';
  result: HostShellActionResult | null;
};

const conversation = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}`;

const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export function HostShellActionCard({
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
  const action = hostShellActionSchema.safeParse(args);
  const recorded = computerToolResult(result);
  const [approval, setApproval] = useState<PendingHostShellApproval>();
  const [approvalError, setApprovalError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const finished = status === 'complete';
  const approvalId = action.success ? action.data.approvalId : '';

  useEffect(() => {
    if (!approvalId) return;
    let active = true;
    setApprovalError('');
    void api<PendingHostShellApproval>(
      `${conversation(threadId)}/host-shell-approvals/${encodeURIComponent(approvalId)}`,
    )
      .then((value) => active && setApproval(value))
      .catch(
        (cause) =>
          active &&
          setApprovalError(
            cause instanceof Error
              ? cause.message
              : 'Could not load this host shell request.',
          ),
      );
    return () => {
      active = false;
    };
  }, [threadId, approvalId]);

  const mismatch = !!receipt && receipt.approvalId !== approvalId;
  const own = mismatch ? null : receipt;
  const running = own?.status === 'running';
  useEffect(() => {
    let active = true;
    const load = () =>
      api<Receipt | null>(
        `${conversation(threadId)}/host-shell-actions/${encodeURIComponent(toolCallId)}`,
      )
        .then((value) => active && setReceipt(value))
        .catch((cause) => {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not check this host shell action.',
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
            'The owner declined this host shell command. Do not perform it or try another way.',
        });
        return;
      }
      const value =
        outcome ??
        (await api<HostShellActionResult>(
          `${conversation(threadId)}/host-shell-actions`,
          'POST',
          { toolCallId, approvalId: action.data.approvalId },
        ));
      setReceipt({ approvalId, status: 'done', result: value });
      await respond({ approved: true, ...value });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not run this host shell command.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      className="page-review-card connection-action-card"
      aria-label="Approve unsafe host shell command"
    >
      <header>
        <Terminal size={17} />
        <strong>Unsafe host shell</strong>
        <span>
          {approved
            ? outcome?.isError
              ? 'Failed'
              : 'Approved'
            : declined
              ? 'Declined'
              : running
                ? 'Running'
                : finished
                  ? 'Ended'
                  : !ready
                    ? 'Checking'
                    : 'Needs your approval'}
        </span>
      </header>
      <div className="page-review-body">
        <h3>{action.success ? action.data.summary : 'Preparing command…'}</h3>
        <p className="muted">
          This runs on the OpenDots host server, not the isolated Dot computer.
          Review the exact command before approving.
        </p>
        {approval && (
          <dl className="connection-action-args">
            <div>
              <dt>cwd</dt>
              <dd>{approval.cwd}</dd>
            </div>
            <div>
              <dt>timeoutMs</dt>
              <dd>{approval.timeoutMs}</dd>
            </div>
            <div>
              <dt>command</dt>
              <dd>{approval.command}</dd>
            </div>
          </dl>
        )}
        {mismatch && (
          <div className="connection-action-result failed">
            <strong>Cannot run</strong>
            <pre>
              This card’s saved result belongs to a different host shell
              approval request. Nothing was run for this one.
            </pre>
          </div>
        )}
        {approvalError && !outcome && (
          <div className="connection-action-result failed">
            <strong>Cannot run</strong>
            <pre>{approvalError}</pre>
          </div>
        )}
        {outcome && (
          <div
            className={`connection-action-result ${outcome.isError ? 'failed' : ''}`}
          >
            <strong>{outcome.isError ? 'Command failed' : 'Command result'}</strong>
            <pre>{display(outcome.text)}</pre>
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
          {running
            ? 'This command is still running on the host.'
            : approved || declined || finished
              ? ''
              : 'Nothing runs until you approve. These are the exact arguments.'}
        </small>
      </footer>
    </section>
  );
}
