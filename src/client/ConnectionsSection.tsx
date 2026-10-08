import { useEffect, useState, type KeyboardEvent } from 'react';
import { PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import type { Connection } from '../shared/connection-types';
import { api } from './api';
import { t } from './i18n';
// Lives inside the Dot form, so it saves immediately through its own
// requests and keeps Enter from submitting the surrounding form.
const stayInSection = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};
export function ConnectionsSection({ dotId }: { dotId: string }) {
  const [connections, setConnections] = useState<Connection[]>();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Connection[]>(`/dots/${encodeURIComponent(dotId)}/connections`)
      .then((value) => active && setConnections(value))
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error ? cause.message : t('connections.loadError'),
          ),
      );
    return () => {
      active = false;
    };
  }, [dotId]);
  const run = async <T,>(key: string, request: () => Promise<T>) => {
    setBusy(key);
    setError('');
    try {
      return await request();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('connections.requestFailed'),
      );
    } finally {
      setBusy('');
    }
  };
  const replace = (next: Connection) =>
    setConnections((list) =>
      list?.map((item) => (item.id === next.id ? next : item)),
    );
  const add = async () => {
    const created = await run('add', () =>
      api<Connection>(
        `/dots/${encodeURIComponent(dotId)}/connections`,
        'POST',
        {
          name: name.trim(),
          url: url.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
        },
      ),
    );
    if (!created) return;
    setConnections((list) => [...(list ?? []), created]);
    setName('');
    setUrl('');
    setToken('');
  };
  return (
    <fieldset className="space-access-fields connections-fields">
      <legend>{t('connections.title')}</legend>
      <p className="muted">{t('connections.intro')}</p>
      {connections?.map((connection) => (
        <div className="connection" key={connection.id}>
          <div className="connection-head">
            <PlugZap size={15} />
            <span>
              <strong>{connection.name}</strong>
              <small>
                {new URL(connection.url).host}
                {connection.hasToken ? ` · ${t('connections.tokenSaved')}` : ''}
              </small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t('connections.refresh').replace(
                '{name}',
                connection.name,
              )}
              disabled={!!busy}
              onClick={async () => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/refresh`,
                    'POST',
                    {},
                  ),
                );
                if (next) replace(next);
              }}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('connections.remove').replace(
                '{name}',
                connection.name,
              )}
              disabled={!!busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    t('connections.removeConfirm').replace(
                      '{name}',
                      connection.name,
                    ),
                  )
                )
                  return;
                const done = await run(connection.id, () =>
                  api(`/connections/${connection.id}`, 'DELETE'),
                );
                if (done)
                  setConnections((list) =>
                    list?.filter((item) => item.id !== connection.id),
                  );
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {connection.error && (
            <p className="chat-error" role="alert">
              {connection.error}
            </p>
          )}
          {!connection.tools.length && (
            <p className="muted">{t('connections.noTools')}</p>
          )}
          <ul className="connection-tools">
            {connection.tools.map((tool) => {
              const patch = async (value: {
                enabled?: boolean;
                requiresApproval?: boolean;
              }) => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/tools/${encodeURIComponent(tool.name)}`,
                    'PATCH',
                    value,
                  ),
                );
                if (next) replace(next);
              };
              return (
                <li key={tool.name}>
                  <label className="permission-row">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={!!busy}
                      onChange={(event) =>
                        void patch({ enabled: event.target.checked })
                      }
                    />
                    <span>
                      <strong>
                        {tool.title}
                        {tool.readOnly && <em>{t('connections.readOnly')}</em>}
                      </strong>
                      {tool.description && <small>{tool.description}</small>}
                    </span>
                  </label>
                  <label className="connection-approval">
                    <input
                      type="checkbox"
                      checked={tool.requiresApproval}
                      disabled={!!busy || !tool.enabled}
                      onChange={(event) =>
                        void patch({ requiresApproval: event.target.checked })
                      }
                    />
                    {t('connections.askFirst')}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="connection-add">
        <label className="field-label" htmlFor="connection-name">
          {t('connections.addServer')}
        </label>
        <input
          id="connection-name"
          placeholder={t('connections.nameExample')}
          maxLength={40}
          value={name}
          onKeyDown={stayInSection}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label={t('connections.serverUrl')}
          placeholder="https://example.com/mcp"
          type="url"
          value={url}
          onKeyDown={stayInSection}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          aria-label={t('connections.bearerOptional')}
          placeholder={t('connections.bearerOptional')}
          type="password"
          autoComplete="off"
          value={token}
          onKeyDown={stayInSection}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="button"
          className="connection-connect"
          disabled={!!busy || !name.trim() || !url.trim()}
          onClick={() => void add()}
        >
          {busy === 'add'
            ? t('connections.connecting')
            : t('connections.connect')}
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
