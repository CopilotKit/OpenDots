import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dot } from '../shared/types';
import type { ComputerAction, ComputerStatus } from '../shared/computer-types';
import { api } from './api';
import { dateLocale, t } from './i18n';

type Screen = {
  base64: string;
  width: number;
  height: number;
  url: string;
  capturedAt: number;
};

export function ComputerPanel({ dot }: { dot: Dot }) {
  const [tab, setTab] = useState<'Browser' | 'Files' | 'Terminal' | 'Activity'>(
    'Browser',
  );
  const [status, setStatus] = useState<ComputerStatus>();
  const [screen, setScreen] = useState<Screen>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [key, setKey] = useState('Enter');
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState('');
  const [contents, setContents] = useState('');
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [outputError, setOutputError] = useState('');
  const [screenError, setScreenError] = useState('');
  const lifecycle = useRef({
    active: false,
    revision: 0,
    busy: false,
    loaded: false,
    running: false,
  });
  const controller = useRef<AbortController | null>(null);
  const base = `/dots/${encodeURIComponent(dot.id)}/computer`;
  const refresh = useCallback(async () => {
    const revision = lifecycle.current.revision;
    const current = () =>
      lifecycle.current.active && revision === lifecycle.current.revision;
    try {
      const next = await api<ComputerStatus>(
        base,
        'GET',
        undefined,
        controller.current?.signal,
      );
      if (!current()) return;
      setStatus(next);
      lifecycle.current.loaded = true;
      lifecycle.current.running = next.state === 'running';
      setError('');
      if (
        next.state === 'running' &&
        next.permissions.browser &&
        next.permissions.enabled
      ) {
        try {
          const capture = await api<Screen>(
            `${base}/actions`,
            'POST',
            { action: 'screenshot', input: {} },
            controller.current?.signal,
          );
          if (current()) {
            setScreen(capture);
            setScreenError('');
          }
        } catch (cause) {
          if (current()) {
            setScreen(undefined);
            setScreenError(
              cause instanceof Error
                ? cause.message
                : t('Could not refresh the screen.'),
            );
          }
        }
      } else {
        setScreen(undefined);
        setScreenError('');
      }
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error
            ? cause.message
            : t('Could not load the computer.'),
        );
        setScreen(undefined);
      }
    }
  }, [base]);
  useEffect(() => {
    lifecycle.current.active = true;
    controller.current = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (
        !document.hidden &&
        !lifecycle.current.busy &&
        (!lifecycle.current.loaded || lifecycle.current.running)
      )
        await refresh();
      if (!cancelled && lifecycle.current.active)
        timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      cancelled = true;
      lifecycle.current.active = false;
      lifecycle.current.revision++;
      controller.current?.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const run = async (
    endpoint: string,
    body: unknown = {},
    method = 'POST',
    showOutput = false,
  ) => {
    if (lifecycle.current.busy) return;
    lifecycle.current.busy = true;
    lifecycle.current.revision++;
    setBusy(true);
    setError('');
    if (showOutput) setOutputError('');
    try {
      const result = await api<unknown>(
        `${base}${endpoint}`,
        method,
        body,
        controller.current?.signal,
      );
      if (!lifecycle.current.active) return;
      if (showOutput)
        setOutput(
          typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        );
      await refresh();
      return result;
    } catch (cause) {
      if (!lifecycle.current.active) return;
      const message =
        cause instanceof Error ? cause.message : t('Computer action failed.');
      // Status polling clears the panel error, so keep output action failures
      // next to the output they replace.
      if (showOutput) {
        setOutput('');
        setOutputError(message);
      } else setError(message);
    } finally {
      lifecycle.current.busy = false;
      if (lifecycle.current.active) setBusy(false);
    }
  };
  const action = (action: ComputerAction, input: unknown, showOutput = false) =>
    run('/actions', { action, input }, 'POST', showOutput);
  const running = status?.state === 'running' && status.permissions.enabled;
  const human =
    status?.control?.holder === 'human' && !status.control.transitioning;
  const browser = !!running && !!status?.permissions.browser;
  return (
    <section
      className="computer-panel"
      aria-label={t("{name}'s computer", { name: dot.name })}
      aria-busy={busy}
    >
      {error && (
        <p className="computer-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p role="status">
          {error ? t('Computer status unavailable.') : t('Loading computer…')}
        </p>
      ) : (
        <>
          <div className="computer-status">
            <strong>{t(status.state.replaceAll('_', ' '))}</strong>
            {status.state !== 'running' && (
              <button disabled={busy} onClick={() => void refresh()}>
                {t('Refresh')}
              </button>
            )}
            <span>
              {busy
                ? t('Working…')
                : human
                  ? t('You have control')
                  : t('Dot control')}
            </span>
          </div>
          {!status.configured && (
            <div className="computer-setup">
              <h3>{t('Connect a computer service')}</h3>
              <p>
                {t(
                  'This Dot does not have a computer service configured. Configure the server’s computer service URL and token, then restart. Each Dot gets its own browser and workspace.',
                )}
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md"
                target="_blank"
                rel="noreferrer"
              >
                {t('Computer setup guide')} ↗
              </a>
            </div>
          )}
          {status.error && (
            <p className="computer-error" role="alert">
              {status.error}
            </p>
          )}
          <div
            className="computer-tool-tabs"
            role="tablist"
            aria-label={t('Computer tools')}
          >
            {(['Browser', 'Files', 'Terminal', 'Activity'] as const).map(
              (name) => (
                <button
                  role="tab"
                  aria-selected={tab === name}
                  key={name}
                  onClick={() => setTab(name)}
                >
                  {t(name)}
                </button>
              ),
            )}
          </div>
          {status.configured && (
            <>
              <section
                className="computer-section computer-browser"
                hidden={tab !== 'Browser'}
              >
                {!status.permissions.browser && (
                  <p>{t('Enable Browser permission to use the screen.')}</p>
                )}
                <form
                  className="computer-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action('navigate', { url });
                  }}
                >
                  <input
                    type="url"
                    aria-label={t('Browser URL')}
                    placeholder="https://example.com"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                    disabled={!browser || busy || human}
                  />
                  <button disabled={!browser || busy || human || !url.trim()}>
                    {t('Go')}
                  </button>
                </form>
                {screenError && (
                  <p className="computer-error" role="status">
                    {screenError}
                  </p>
                )}
                {screen ? (
                  <>
                    <div className="computer-current-url" title={screen.url}>
                      {screen.url || t('Browser screen')}
                    </div>
                    <button
                      className="computer-screen"
                      aria-label={
                        human
                          ? t('Click a point on the computer screen')
                          : t('Computer screen; take control to interact')
                      }
                      disabled={!browser || !human || busy}
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        void action('human_click', {
                          x: Math.min(
                            screen.width - 1,
                            Math.max(
                              0,
                              Math.floor(
                                ((event.clientX - rect.left) / rect.width) *
                                  screen.width,
                              ),
                            ),
                          ),
                          y: Math.min(
                            screen.height - 1,
                            Math.max(
                              0,
                              Math.floor(
                                ((event.clientY - rect.top) / rect.height) *
                                  screen.height,
                              ),
                            ),
                          ),
                        });
                      }}
                    >
                      <img
                        src={`data:image/png;base64,${screen.base64}`}
                        alt={t('Live browser screen for {name}', {
                          name: dot.name,
                        })}
                      />
                    </button>
                    <small>
                      {t(
                        'Refreshed {time}. Screen updates while this panel is open.',
                        {
                          time: new Date(screen.capturedAt).toLocaleTimeString(
                            dateLocale,
                          ),
                        },
                      )}
                    </small>
                  </>
                ) : (
                  <p className="computer-screen-empty">
                    {running && status.permissions.browser
                      ? t('Waiting for the browser screen…')
                      : t(
                          'Start the computer with Browser permission to see its screen.',
                        )}
                  </p>
                )}
                <div className="computer-control-pill">
                  <span>
                    {human
                      ? t('You have control')
                      : t('{name} has control', { name: dot.name })}
                  </span>
                  <button
                    disabled={
                      (!human && !browser) ||
                      busy ||
                      status.control?.transitioning
                    }
                    onClick={() => void run(human ? '/release' : '/take')}
                  >
                    {human ? t('Return control') : t('Take over')}
                  </button>
                </div>
                {status.control?.transitioning && (
                  <p role="status">{t('Transferring control…')}</p>
                )}
                {human && (
                  <details className="computer-human">
                    <summary>{t('Keyboard & precise controls')}</summary>
                    <p>
                      {t(
                        'Click the screen or enter coordinates below. Text goes directly to this browser, outside chat. Return control when finished.',
                      )}
                    </p>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action('human_click', point);
                      }}
                    >
                      <label>
                        X
                        <input
                          type="number"
                          min="0"
                          max={screen ? screen.width - 1 : undefined}
                          value={point.x}
                          onChange={(event) =>
                            setPoint({
                              ...point,
                              x: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Y
                        <input
                          type="number"
                          min="0"
                          max={screen ? screen.height - 1 : undefined}
                          value={point.y}
                          onChange={(event) =>
                            setPoint({
                              ...point,
                              y: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <button disabled={busy || !browser || !screen}>
                        {t('Click')}
                      </button>
                    </form>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const value = text;
                        setText('');
                        void action('human_type', { text: value });
                      }}
                    >
                      <input
                        type="password"
                        aria-label={t('Text to type into computer')}
                        placeholder={t('Type into focused field')}
                        autoComplete="off"
                        value={text}
                        maxLength={20000}
                        onChange={(event) => setText(event.target.value)}
                      />
                      <button disabled={busy || !browser || !text}>
                        {t('Type')}
                      </button>
                    </form>
                    <form
                      className="computer-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action('human_key', { key });
                      }}
                    >
                      <select
                        aria-label={t('Key to press')}
                        value={key}
                        onChange={(event) => setKey(event.target.value)}
                      >
                        {[
                          'Enter',
                          'Tab',
                          'Escape',
                          'Backspace',
                          'ArrowUp',
                          'ArrowDown',
                          'ArrowLeft',
                          'ArrowRight',
                        ].map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                      <button disabled={busy || !browser}>
                        {t('Press key')}
                      </button>
                    </form>
                    <div className="computer-actions">
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: -500 })
                        }
                      >
                        {t('Scroll up')}
                      </button>
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: 500 })
                        }
                      >
                        {t('Scroll down')}
                      </button>
                    </div>
                  </details>
                )}
              </section>
              <details
                className="computer-section"
                open
                hidden={tab !== 'Files'}
              >
                <summary>{t('Workspace files')}</summary>
                <p>
                  {t('Paths are relative to this Dot’s persistent workspace.')}
                </p>
                <label>
                  {t('Path')}
                  <input
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder={t('notes.txt')}
                    disabled={!running || !status.permissions.files || busy}
                  />
                </label>
                <div className="computer-actions">
                  <button
                    disabled={!running || !status.permissions.files || busy}
                    onClick={() => void action('files_list', { path }, true)}
                  >
                    {t('List files')}
                  </button>
                  <button
                    disabled={
                      !running ||
                      !status.permissions.files ||
                      busy ||
                      !path.trim()
                    }
                    onClick={() =>
                      void action('files_read', { path }, true).then(
                        (result) => {
                          if (
                            lifecycle.current.active &&
                            result &&
                            typeof result === 'object' &&
                            'text' in result &&
                            typeof result.text === 'string'
                          )
                            setContents(result.text);
                        },
                      )
                    }
                  >
                    {t('Read file')}
                  </button>
                </div>
                <label>
                  {t('File contents')}
                  <textarea
                    aria-label={t('File contents to save')}
                    value={contents}
                    onChange={(event) => setContents(event.target.value)}
                    disabled={!running || !status.permissions.files || busy}
                    maxLength={100000}
                    rows={5}
                  />
                </label>
                <button
                  disabled={
                    !running ||
                    !status.permissions.files ||
                    busy ||
                    !path.trim()
                  }
                  onClick={() =>
                    void action('files_write', { path, contents }, true)
                  }
                >
                  {t('Save file (replace contents)')}
                </button>
                {!status.permissions.files && (
                  <p>
                    {t(
                      'Enable Workspace files permission to use these controls.',
                    )}
                  </p>
                )}
              </details>
              <details
                className="computer-section"
                open
                hidden={tab !== 'Terminal'}
              >
                <summary>{t('Terminal')}</summary>
                <p>
                  {t(
                    'Runs inside this Dot’s computer. Commands stop after 30 seconds.',
                  )}
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action('exec', { command, timeoutMs: 30000 }, true);
                  }}
                >
                  <textarea
                    aria-label={t('Terminal command')}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    maxLength={8000}
                    rows={3}
                    disabled={!running || !status.permissions.shell || busy}
                    placeholder="pwd"
                  />
                  <button
                    disabled={
                      !running ||
                      !status.permissions.shell ||
                      busy ||
                      !command.trim()
                    }
                  >
                    {t('Run command')}
                  </button>
                </form>
                {!status.permissions.shell && (
                  <p>
                    {t('Enable Terminal commands permission to run commands.')}
                  </p>
                )}
              </details>
              {(output || outputError) &&
                (tab === 'Files' || tab === 'Terminal') && (
                  <section className="computer-section">
                    <h3>{t('Output')}</h3>
                    {outputError && (
                      <p className="computer-error" role="alert">
                        {outputError}
                      </p>
                    )}
                    {output && <pre tabIndex={0}>{output}</pre>}
                    <button
                      onClick={() => {
                        setOutput('');
                        setOutputError('');
                      }}
                    >
                      {t('Clear output')}
                    </button>
                  </section>
                )}
            </>
          )}
          <details
            className="computer-section"
            open
            hidden={tab !== 'Activity'}
          >
            <summary>{t('Recent activity')}</summary>
            {status.audit.length ? (
              <ol className="computer-audit">
                {status.audit
                  .slice(-30)
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id}>
                      <strong>{t(entry.action.replaceAll('_', ' '))}</strong>
                      <span>
                        {entry.actor} · {entry.outcome} ·{' '}
                        {new Date(entry.createdAt).toLocaleTimeString(
                          dateLocale,
                        )}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p>{t('No computer actions yet.')}</p>
            )}
          </details>
          <details className="computer-settings">
            <summary>{t('Computer settings')}</summary>{' '}
            <details
              className="computer-permissions"
              open={!status.permissions.enabled}
            >
              <summary>{t('Computer permissions')}</summary>
              <p>
                {t('Choose what {name} and the computer controls can access.', {
                  name: dot.name,
                })}
              </p>
              {(['enabled', 'browser', 'files', 'shell'] as const).map(
                (permission) => (
                  <label key={permission}>
                    <input
                      type="checkbox"
                      checked={status.permissions[permission]}
                      disabled={busy || !status.configured}
                      onChange={(event) =>
                        void run(
                          '/permissions',
                          { [permission]: event.target.checked },
                          'PATCH',
                        )
                      }
                    />
                    {
                      {
                        enabled: t('Enable this computer'),
                        browser: t('Browser'),
                        files: t('Workspace files'),
                        shell: t('Terminal commands'),
                      }[permission]
                    }
                  </label>
                ),
              )}
            </details>
            <div className="computer-actions">
              <button
                disabled={
                  busy ||
                  !status.configured ||
                  !status.permissions.enabled ||
                  status.state === 'running'
                }
                onClick={() => void run('/start')}
              >
                {t('Start computer')}
              </button>
              <button
                disabled={busy || status.state !== 'running'}
                onClick={() => void run('/stop')}
              >
                {t('Stop computer')}
              </button>
            </div>
            <p className="computer-hint">
              {t(
                'Stopping retains this Dot’s workspace files. Browser sessions may require signing in again.',
              )}
            </p>
          </details>
        </>
      )}
    </section>
  );
}
