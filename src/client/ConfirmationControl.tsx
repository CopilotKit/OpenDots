import { useEffect, useState } from 'react';
import { api } from './api';

export function ConfirmationControl() {
  const [mode, setMode] = useState<'confirm' | 'unattended'>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ mode: 'confirm' | 'unattended' }>(
      '/confirmation-policy',
      'GET',
      undefined,
      controller.signal,
    )
      .then((policy) => {
        if (!controller.signal.aborted) setMode(policy.mode);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="config-note">
      <strong>Local PC confirmations</strong>
      <p>
        {mode === 'unattended'
          ? 'Unattended actions enabled'
          : mode
            ? 'Confirmations enabled'
            : 'Loading confirmation mode…'}
      </p>
      <p>
        Unattended mode skips native prompts for local file changes, desktop
        clicks, typing, keys, app launches, opening paths and browser actions,
        including sends. It applies to all Dots using LocalTools. Tool
        permissions, Pause and browser takeover still apply.
      </p>
      <button
        type="button"
        disabled={!mode || busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await api<{ mode: 'confirm' | 'unattended' }>(
              '/confirmation-policy',
              'PUT',
              { mode: mode === 'confirm' ? 'unattended' : 'confirm' },
            );
            setMode(result.mode);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Saving…'
          : mode === 'unattended'
            ? 'Turn confirmations back on'
            : 'Enable unattended actions'}
      </button>
      <p>
        Changes apply to the next action. An already-open confirmation must be
        answered or cancelled. Existing browser site exceptions still apply when
        confirmations are on.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
