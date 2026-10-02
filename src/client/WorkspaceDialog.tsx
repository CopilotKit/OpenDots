import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState(
    workspace.setup.modelProvider ?? 'openai-compatible',
  );
  const [chatgptModels, setChatgptModels] = useState<
    { slug: string; displayName: string }[]
  >([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    setProvider(workspace.setup.modelProvider ?? 'openai-compatible');
    if (workspace.setup.chatgpt?.connected) setSigningIn(false);
    if (
      dialog.type !== 'settings' ||
      !workspace.setup.chatgpt?.connected ||
      !workspace.setup.chatgpt?.sharing
    )
      return;
    let active = true;
    void api<{ models: { slug: string; displayName: string }[] }>(
      '/chatgpt/models',
    )
      .then((result) => {
        if (active) setChatgptModels(result.models);
      })
      .catch(() => {
        if (active) setChatgptModels([]);
      });
    return () => {
      active = false;
    };
  }, [
    dialog.type,
    workspace.setup.modelProvider,
    workspace.setup.chatgpt?.connected,
    workspace.setup.chatgpt?.sharing,
  ]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
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
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = { researchAllowed: research, memoryAllowed: memory };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                intervalSeconds: Number(interval),
              };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    Include your preferences in new turns. Changing permission
                    stops active work.
                  </small>
                </span>
              </label>
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Automatic Learning</legend>
              <label className="field-label" htmlFor="learning-container">
                Learning container ID
              </label>
              <input
                id="learning-container"
                value={learningContainer}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="research-workflow"
                aria-describedby="learning-help"
                onChange={(event) => {
                  setLearningContainer(event.target.value);
                  if (!event.target.value.trim()) setSkillDelivery(false);
                }}
              />
              <p className="muted" id="learning-help">
                Create this container in your Intelligence project first. New
                conversations will contribute evidence to it. Leave blank to
                keep new conversations out of Learning. Existing conversations
                retain their original assignment.
              </p>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={skillDelivery}
                  disabled={!learningContainer.trim()}
                  onChange={(event) => setSkillDelivery(event.target.checked)}
                />
                <span>
                  <strong>Use published skills</strong>
                  <small>
                    Load reviewed skills from each conversation’s assigned
                    container. Enable delivery in Intelligence too. Turning this
                    off stops skill loading; it does not stop evidence
                    collection.
                  </small>
                </span>
              </label>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                Set up Learning and review skills ↗
              </a>
            </fieldset>
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Failed runs wait for manual retry.
              </p>
            </>
          )}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>Text model</strong>
              {workspace.setup.chatgpt?.connected ? (
                <>
                  <p>
                    ChatGPT account · Connected ✓
                    {workspace.setup.chatgpt?.sharing
                      ? ' · Plan usage enabled'
                      : ' · Plan usage needs permission'}
                    {provider === 'chatgpt-plan'
                      ? ' · Selected'
                      : ' · Not selected'}
                  </p>
                  <p>{workspace.setup.chatgpt.email ?? 'ChatGPT account'}</p>
                  {workspace.setup.chatgpt?.sharing && (
                    <>
                      <label className="field-label" htmlFor="chatgpt-model">
                        Model
                      </label>
                      <select
                        id="chatgpt-model"
                        value={workspace.setup.chatgpt.model ?? ''}
                        disabled={modelBusy || !chatgptModels.length}
                        onChange={async (event) => {
                          setModelBusy(true);
                          const ok = await mutate('/chatgpt/model', 'PUT', {
                            model: event.target.value,
                          });
                          setModelBusy(false);
                          if (!ok)
                            setError('Could not select that ChatGPT model.');
                        }}
                      >
                        {!chatgptModels.length && (
                          <option value="">Loading available models…</option>
                        )}
                        {chatgptModels.map((model) => (
                          <option key={model.slug} value={model.slug}>
                            {model.displayName}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <div className="button-row">
                    <a
                      href="https://chatgpt.com/settings/usage"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage usage ↗
                    </a>
                    <button
                      type="button"
                      disabled={modelBusy}
                      onClick={async () => {
                        setModelBusy(true);
                        const result = await api<{ revoked: boolean }>(
                          '/chatgpt/auth',
                          'DELETE',
                        );
                        setProvider('openai-compatible');
                        setModelBusy(false);
                        if (!result.revoked)
                          setError(
                            'Disconnected locally. OpenAI could not confirm remote revocation; you can disconnect OpenDots from ChatGPT Settings.',
                          );
                        else setError('ChatGPT disconnected.');
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                  <p className="muted">
                    Eligible requests use your ChatGPT plan limits. There is no
                    automatic API-key fallback.
                  </p>
                  {workspace.setup.chatgpt?.needsReconsent && !signingIn && (
                    <button
                      type="button"
                      disabled={modelBusy}
                      onClick={async () => {
                        setSigningIn(true);
                        const popup = window.open('about:blank', '_blank');
                        try {
                          const result = await api<{
                            authorizationUrl: string;
                          }>('/chatgpt/auth/start', 'POST', {});
                          if (popup)
                            popup.location.href = result.authorizationUrl;
                          else window.location.href = result.authorizationUrl;
                        } catch {
                          popup?.close();
                          setSigningIn(false);
                          setError(
                            'Could not request ChatGPT plan permission.',
                          );
                        }
                      }}
                    >
                      Enable ChatGPT plan usage
                    </button>
                  )}
                  {workspace.setup.chatgpt?.usable &&
                    workspace.setup.modelProvider !== 'chatgpt-plan' && (
                      <button
                        type="button"
                        disabled={modelBusy}
                        onClick={async () => {
                          setModelBusy(true);
                          const ok = await mutate('/model-provider', 'PUT', {
                            provider: 'chatgpt-plan',
                          });
                          setModelBusy(false);
                          if (ok) setProvider('chatgpt-plan');
                        }}
                      >
                        Use ChatGPT plan
                      </button>
                    )}
                </>
              ) : (
                <>
                  <p>Use your ChatGPT plan</p>
                  {signingIn ? (
                    <>
                      <p>
                        Opening ChatGPT sign-in… Complete authorization in your
                        browser.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          void api('/chatgpt/auth/cancel', 'POST', {});
                          setSigningIn(false);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={modelBusy}
                      onClick={async () => {
                        setSigningIn(true);
                        const popup = window.open('about:blank', '_blank');
                        try {
                          const result = await api<{
                            authorizationUrl: string;
                          }>('/chatgpt/auth/start', 'POST', {});
                          if (popup)
                            popup.location.href = result.authorizationUrl;
                          else window.location.href = result.authorizationUrl;
                        } catch {
                          popup?.close();
                          setSigningIn(false);
                          setError('Could not start ChatGPT sign-in.');
                        }
                      }}
                    >
                      {workspace.setup.chatgpt?.needsReconsent
                        ? 'Enable ChatGPT plan usage'
                        : 'Continue with ChatGPT'}
                    </button>
                  )}
                  <p className="muted">
                    Use your eligible Plus / Pro allowance. No OpenAI API key
                    required.
                  </p>
                </>
              )}
              <hr />
              <strong>
                OpenAI-compatible API
                {provider === 'openai-compatible' ? ' · Selected' : ''}
              </strong>
              <p>
                {workspace.setup.apiProviderAvailable
                  ? 'Configured from the server environment.'
                  : 'Configure OPENAI_API_KEY and OPENAI_MODEL in the server environment.'}
              </p>
              {workspace.setup.chatgpt?.connected &&
                workspace.setup.modelProvider !== 'openai-compatible' &&
                workspace.setup.apiProviderAvailable && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await mutate('/model-provider', 'PUT', {
                        provider: 'openai-compatible',
                      });
                      if (ok) setProvider('openai-compatible');
                    }}
                  >
                    Switch to API-key provider
                  </button>
                )}
              <p className="muted">
                Realtime voice still requires its separate VOICE_API_KEY.
              </p>
              <strong>Service setup</strong>
              <p>
                {workspace.setup.missing.length
                  ? `Still needed: ${workspace.setup.missing.map((item) => (item === 'ChatGPT plan connection/model' ? 'ChatGPT plan connection (use Continue with ChatGPT above)' : `${item} in the server environment`)).join(', ')}. Restart after changing environment settings.`
                  : 'Text configuration is present. A successful conversation confirms connectivity.'}
              </p>
              <p>
                Slack: {workspace.setup.slack.replaceAll('_', ' ')}. Voice:{' '}
                {workspace.setup.voice
                  ? 'configuration present'
                  : 'needs VOICE_API_KEY and VOICE_MODEL'}
                .
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                target="_blank"
                rel="noreferrer"
              >
                Template setup guide ↗
              </a>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>
    </div>
  );
}
