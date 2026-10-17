import { useId, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import type { ModelCheck, SetupStatus } from '../shared/types';
import { api } from './api';

// Server hints mark settings and commands with `backticks`.
function withCode(text: string) {
  return text
    .split('`')
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

/** Shows the server's model provider and checks its endpoint on request. */
export function ModelSetup({ setup }: { setup: SetupStatus }) {
  const [check, setCheck] = useState<ModelCheck>();
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const resultId = useId();
  const ollama = setup.modelProvider === 'ollama';
  async function run() {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    // Clear the previous result so an identical one is announced again.
    setCheck(undefined);
    try {
      setCheck(await api<ModelCheck>('/setup/model'));
    } catch (error) {
      setCheck({
        ok: false,
        provider: setup.modelProvider,
        models: [],
        message:
          error instanceof Error
            ? error.message
            : "The model check didn't finish. Try again.",
      });
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }
  const Icon = check?.ok ? CircleCheck : CircleAlert;
  return (
    <div className="model-setup">
      <p>
        Model provider: {ollama ? 'Ollama (local)' : 'OpenAI'}
        {ollama && (
          <>
            {' '}
            at <code>{setup.modelBaseUrl}</code>, no API key
          </>
        )}
        .
      </p>
      {!setup.model && (
        <p>
          In the server <code>.env</code>, set <code>OPENAI_API_KEY</code> and{' '}
          <code>OPENAI_MODEL</code> for OpenAI, or{' '}
          <code>MODEL_PROVIDER=ollama</code> and <code>OLLAMA_MODEL</code> for a
          local Ollama model. Restart after changes.
        </p>
      )}
      {(ollama || setup.model) && (
        <button
          type="button"
          className="model-check-button"
          // aria-disabled keeps keyboard focus on the button while checking.
          aria-disabled={checking}
          aria-busy={checking}
          aria-describedby={resultId}
          onClick={() => void run()}
        >
          {checking && <LoaderCircle size={13} className="spin" aria-hidden />}
          {checking
            ? 'Checking…'
            : check
              ? 'Check again'
              : ollama
                ? 'Check Ollama'
                : 'Check model'}
        </button>
      )}
      <div
        id={resultId}
        className={`model-check${check ? (check.ok ? ' ok' : ' problem') : ''}`}
        role="status"
        aria-live="polite"
      >
        {check && (
          <>
            <Icon className="model-check-icon" size={15} aria-hidden />
            <p className="model-check-headline">{check.message}</p>
            {check.hint && <p>{withCode(check.hint)}</p>}
            {check.models.length > 0 && (
              <p>
                {check.ok ? 'Also available' : 'Available models'}:{' '}
                {check.models.map((model, index) => (
                  <span key={model}>
                    {index > 0 && ', '}
                    <code>{model}</code>
                  </span>
                ))}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
