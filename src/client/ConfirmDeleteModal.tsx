import { useEffect, useRef } from 'react';
import { Trash2, X } from 'lucide-react';

/**
 * Confirmation dialog for permanently deleting a chat thread.
 *
 * Deletion is immediate and irreversible: the conversation and its messages
 * are removed from both the local workspace and the Intelligence store, so the
 * dialog states that clearly instead of offering undo.
 */
export function ConfirmDeleteModal({
  title,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const container = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Keep the latest callback without re-running the focus setup on every
  // render: the parent re-renders on each poll, which would steal focus.
  const cancelHandler = useRef(onCancel);
  cancelHandler.current = onCancel;
  useEffect(() => {
    cancelRef.current?.focus?.();
    if (typeof document === 'undefined') return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelHandler.current();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      const previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <section
        className="modal confirm-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        aria-describedby="confirm-delete-description"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close delete confirmation"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">CHAT THREAD</span>
        <h2 id="confirm-delete-title">Delete “{title}”?</h2>
        <p className="muted" id="confirm-delete-description">
          This permanently removes the conversation, its messages, and its
          activity from the app and from CopilotKit Intelligence. This action
          cannot be undone.
        </p>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="secondary"
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm}>
            <Trash2 size={15} />
            {busy ? 'Deleting…' : 'Delete thread'}
          </button>
        </div>
      </section>
    </div>
  );
}
