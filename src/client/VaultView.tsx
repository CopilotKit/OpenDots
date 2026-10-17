import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import type {
  PloopDesktopApi,
  PloopLogin,
  PloopLoginInput,
  PloopSettingsPatch,
  PloopSettingsStatus,
} from './desktop';

// The Vault lives in the ploop Mac app: logins are encrypted with a key in the
// Keychain, and only the app ever handles a password. This page asks the app
// through `window.ploop`; it never sees a password unless the owner asks to
// show one and confirms with Touch ID.
const REVEAL_MS = 15_000;

function message(error: unknown, fallback = 'Something went wrong.') {
  return error instanceof Error ? error.message : fallback;
}

function host(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function LoginForm({
  login,
  onSave,
  onCancel,
}: {
  login?: PloopLogin;
  onSave(values: PloopLoginInput): Promise<void>;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(login?.label ?? '');
  const [url, setUrl] = useState(login?.url ?? '');
  const [username, setUsername] = useState(login?.username ?? '');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState(login?.notes ?? '');
  const [agentAccess, setAgentAccess] = useState(login?.agentAccess ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({
        label,
        url,
        username,
        // Editing without typing a password keeps the saved one.
        ...(password || !login ? { password } : {}),
        notes,
        agentAccess,
      } as PloopLoginInput);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="vault-form" onSubmit={(event) => void submit(event)}>
      <label>
        Name
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Optional, e.g. Bank"
        />
      </label>
      <label>
        Sign-in page
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/login"
          required
        />
      </label>
      <label>
        Username or email
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={login ? 'Leave empty to keep the saved one' : ''}
          required={!login}
        />
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <label className="vault-check">
        <input
          type="checkbox"
          checked={agentAccess}
          onChange={(e) => setAgentAccess(e.target.checked)}
        />
        ploop can use this login
      </label>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button className="primary" disabled={busy}>
          {login ? 'Save changes' : 'Save login'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Logins({ api }: { api: PloopDesktopApi }) {
  const [logins, setLogins] = useState<PloopLogin[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [revealed, setRevealed] = useState<{ id: string; password: string }>();
  const [notice, setNotice] = useState<{ id: string; text: string }>();
  const [busy, setBusy] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setLogins(await api.vault.list());
      setError('');
    } catch (caught) {
      setError(message(caught, 'Could not open the vault.'));
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // A shown password hides itself.
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(undefined), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealed]);
  const run = async (id: string, action: () => Promise<string | void>) => {
    setBusy(id);
    setNotice(undefined);
    try {
      const text = await action();
      if (text) setNotice({ id, text });
    } catch (caught) {
      const text = message(caught);
      if (text !== 'Cancelled.') setNotice({ id, text });
    } finally {
      setBusy(undefined);
    }
  };
  const editingLogin = logins?.find((login) => login.id === editing);
  return (
    <section className="vault-section" aria-labelledby="vault-logins">
      <div className="vault-heading">
        <h2 id="vault-logins">Logins</h2>
        {editing === undefined && (
          <button onClick={() => setEditing('new')}>
            <Plus size={15} />
            Add a login
          </button>
        )}
      </div>
      <p className="muted">
        Passwords are encrypted with a key kept in your Mac’s Keychain and never
        leave this computer. A Dot can use a login you allow, but only the app
        handles the password, and the app asks you before each sign-in.
      </p>
      {editing === 'new' && (
        <LoginForm
          onCancel={() => setEditing(undefined)}
          onSave={async (values) => {
            await api.vault.add(values);
            setEditing(undefined);
            await reload();
          }}
        />
      )}
      {editingLogin && (
        <LoginForm
          key={editingLogin.id}
          login={editingLogin}
          onCancel={() => setEditing(undefined)}
          onSave={async (values) => {
            await api.vault.update(editingLogin.id, values);
            setEditing(undefined);
            await reload();
          }}
        />
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {logins === undefined && !error && <p role="status">Opening…</p>}
      {logins?.length === 0 && editing !== 'new' && (
        <p className="vault-empty">
          Add the sign-in page, username and password for a site. Then ask a Dot
          to sign in to it.
        </p>
      )}
      <ul className="vault-list">
        {logins?.map((login) => (
          <li key={login.id}>
            <div className="vault-login">
              <div>
                <strong>{login.label || host(login.url)}</strong>
                <span className="muted">
                  {login.username} · {host(login.url)}
                </span>
              </div>
              <label className="vault-check">
                <input
                  type="checkbox"
                  checked={login.agentAccess}
                  disabled={busy === login.id}
                  onChange={(event) =>
                    void run(login.id, async () => {
                      await api.vault.update(login.id, {
                        agentAccess: event.target.checked,
                      });
                      await reload();
                    })
                  }
                />
                ploop can use this
              </label>
            </div>
            {revealed?.id === login.id && (
              <code className="vault-password">{revealed.password}</code>
            )}
            <div className="vault-actions">
              <button
                disabled={busy === login.id}
                onClick={() =>
                  void run(
                    login.id,
                    async () => (await api.vault.signIn(login.id)).note,
                  )
                }
              >
                Sign in
              </button>
              <button
                disabled={busy === login.id}
                onClick={() =>
                  revealed?.id === login.id
                    ? setRevealed(undefined)
                    : void run(login.id, async () => {
                        setRevealed({
                          id: login.id,
                          password: await api.vault.reveal(login.id),
                        });
                      })
                }
              >
                {revealed?.id === login.id ? 'Hide password' : 'Show password'}
              </button>
              <button
                disabled={busy === login.id}
                onClick={() =>
                  void run(login.id, async () => {
                    await api.vault.copyPassword(login.id);
                    return 'Copied. It clears from the clipboard in 30 seconds.';
                  })
                }
              >
                Copy password
              </button>
              <button onClick={() => setEditing(login.id)}>Edit</button>
              {deleting === login.id ? (
                <>
                  <button
                    className="danger"
                    onClick={() =>
                      void run(login.id, async () => {
                        await api.vault.remove(login.id);
                        setDeleting(undefined);
                        await reload();
                      })
                    }
                  >
                    Yes, delete
                  </button>
                  <button onClick={() => setDeleting(undefined)}>Keep</button>
                </>
              ) : (
                <button onClick={() => setDeleting(login.id)}>Delete</button>
              )}
            </div>
            {notice?.id === login.id && (
              <p role="status" className="muted">
                {notice.text}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const keyFields = [
  {
    key: 'openrouterApiKey',
    label: 'OpenRouter API key',
    hint: 'ploop thinks with models on OpenRouter. Create a key at openrouter.ai.',
  },
  {
    key: 'intelligenceApiKey',
    label: 'CopilotKit Intelligence key',
    hint: 'ploop keeps its conversations in CopilotKit Intelligence. Run `npx copilotkit@latest project select` to get one.',
  },
] as const;

function Settings({ api }: { api: PloopDesktopApi }) {
  const [status, setStatus] = useState<PloopSettingsStatus>();
  const [patch, setPatch] = useState<PloopSettingsPatch>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.settings
      .status()
      .then(setStatus)
      .catch((caught) => setError(message(caught)));
  }, [api]);
  const field = (key: keyof PloopSettingsPatch, fallback = '') =>
    patch[key] ?? fallback;
  const set = (key: keyof PloopSettingsPatch, value: string) =>
    setPatch((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // The app restarts ploop's server with the new settings and reloads.
      await api.settings.save(patch);
    } catch (caught) {
      setError(message(caught));
      setSaving(false);
    }
  };
  if (!status)
    return error ? (
      <p className="chat-error" role="alert">
        {error}
      </p>
    ) : null;
  return (
    <form className="vault-section" onSubmit={(event) => void save(event)}>
      <h2 id="keys">Keys</h2>
      <p className="muted">
        Keys are encrypted next to the vault and handed only to ploop’s server
        on this Mac. Leave a field empty to keep what is saved.
      </p>
      <div className="vault-form">
        {keyFields.map(({ key, label, hint }) => (
          <label key={key}>
            {label} {status[key] ? '(saved)' : '(not set)'}
            <input
              type="password"
              autoComplete="off"
              value={field(key)}
              onChange={(e) => set(key, e.target.value)}
            />
            <small className="muted">{hint}</small>
          </label>
        ))}
        <label>
          Model
          <input
            value={field('model', status.model)}
            onChange={(e) => set('model', e.target.value)}
            placeholder="anthropic/claude-opus-4"
          />
        </label>
      </div>
      <h2>Computer</h2>
      <p className="muted">
        Link a Linux machine you can log in to over SSH, such as a free cloud
        VM. Dots get files and a terminal there. ploop uses your own key file
        and never reads it. Clear the address to unlink it.
      </p>
      <div className="vault-form">
        <label>
          Address
          <input
            value={field('sshHost', status.sshHost)}
            onChange={(e) => set('sshHost', e.target.value)}
            placeholder="203.0.113.10"
          />
        </label>
        <label>
          Username
          <input
            value={field('sshUser', status.sshUser)}
            onChange={(e) => set('sshUser', e.target.value)}
            placeholder="ploop"
          />
        </label>
        <label>
          Port
          <input
            value={field('sshPort', status.sshPort)}
            onChange={(e) => set('sshPort', e.target.value)}
            placeholder="22"
            inputMode="numeric"
          />
        </label>
        <label>
          Key file
          <input
            value={field('sshKeyPath', status.sshKeyPath)}
            onChange={(e) => set('sshKeyPath', e.target.value)}
            placeholder="/Users/you/.ssh/ploop"
          />
        </label>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button
          className="primary"
          disabled={saving || !Object.keys(patch).length}
        >
          {saving ? 'Restarting ploop…' : 'Save and restart'}
        </button>
      </div>
    </form>
  );
}

function About({ api }: { api: PloopDesktopApi }) {
  const [info, setInfo] = useState<{ version: string; signed: boolean }>();
  const [status, setStatus] = useState('');
  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch(() => {});
  }, [api]);
  return (
    <section className="vault-section" aria-labelledby="vault-about">
      <h2 id="vault-about">About</h2>
      <p className="muted">
        ploop {info?.version ?? ''}.{' '}
        {info?.signed
          ? 'Updates download and install after you agree.'
          : 'This build tells you when a new version is out and opens the download page.'}
      </p>
      <div className="vault-actions">
        <button
          onClick={() => {
            setStatus('Checking…');
            api.app
              .checkForUpdates()
              .then(() => setStatus(''))
              .catch(() => setStatus('Could not check for updates.'));
          }}
        >
          Check for updates
        </button>
      </div>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

export function VaultView({ api }: { api: PloopDesktopApi }) {
  return (
    <main className="main-content vault">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <KeyRound size={13} /> ON THIS MAC
          </span>
          <h1>Vault</h1>
          <p>Logins your Dots can use, and the keys ploop runs on.</p>
        </div>
      </div>
      <Logins api={api} />
      <Settings api={api} />
      <About api={api} />
    </main>
  );
}
