import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dot } from '../shared/types';
import { t } from './i18n';
import type { ComputerAction, ComputerStatus } from '../shared/computer-types';
import { api } from './api';

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
  const actionLabels: Record<string, string> = {
    navigate: t('computer.openWebsite'),
    snapshot: t('computer.inspectBrowser'),
    read: t('computer.readPage'),
    screenshot: t('computer.viewBrowser'),
    click: t('computer.clickBrowser'),
    type: t('computer.typeBrowser'),
    key: t('computer.keyboard'),
    scroll: t('computer.scrollPage'),
    files_write: t('computer.saveFile'),
    files_read: t('computer.readFile'),
    files_list: t('computer.listFiles'),
    exec: t('computer.runCommand'),
    human_click: t('computer.click'),
    human_type: t('computer.type'),
    human_key: t('computer.keyboard'),
    start: t('computer.startComputer'),
    stop: t('computer.stopComputer'),
    permissions: t('computer.permissions'),
  };
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
                : t('computer.refreshScreenError'),
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
          cause instanceof Error ? cause.message : t('computer.loadError'),
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
        cause instanceof Error ? cause.message : t('computer.actionFailed');
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
      aria-label={`${dot.name}'s computer`}
      aria-busy={busy}
    >
      {error && (
        <p className="computer-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p role="status">
          {error ? t('computer.unavailable') : t('computer.loading')}
        </p>
      ) : (
        <>
          <div className="computer-status">
            <strong>
              {status.state === 'not_configured'
                ? t('computer.stateNotConfigured')
                : status.state === 'running'
                  ? t('computer.stateRunning')
                  : status.state === 'unavailable'
                    ? t('computer.stateUnavailable')
                    : t('computer.stateStopped')}
            </strong>
            {status.state !== 'running' && (
              <button disabled={busy} onClick={() => void refresh()}>
                {t('computer.refresh')}
              </button>
            )}
            <span>
              {busy
                ? t('computer.working')
                : human
                  ? t('computer.humanControl')
                  : t('computer.agentControl')}
            </span>
          </div>
          {!status.configured && (
            <div className="computer-setup">
              <h3>{t('computer.connect')}</h3>
              <p>{t('computer.setupText')}</p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md"
                target="_blank"
                rel="noreferrer"
              >
                {t('computer.setupGuide')} ↗
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
            aria-label={t('computer.tools')}
          >
            {(['Browser', 'Files', 'Terminal', 'Activity'] as const).map(
              (name) => (
                <button
                  role="tab"
                  aria-selected={tab === name}
                  key={name}
                  onClick={() => setTab(name)}
                >
                  {name === 'Browser'
                    ? t('computer.tabBrowser')
                    : name === 'Files'
                      ? t('computer.tabFiles')
                      : name === 'Activity'
                        ? t('computer.tabActivity')
                        : t('computer.terminal')}
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
                  <p>{t('computer.browserPermission')}</p>
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
                    aria-label={t('computer.browserUrl')}
                    placeholder="https://example.com"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                    disabled={!browser || busy || human}
                  />
                  <button disabled={!browser || busy || human || !url.trim()}>
                    Go
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
                      {screen.url || t('computer.browserScreen')}
                    </div>
                    <button
                      className="computer-screen"
                      aria-label={
                        human
                          ? t('computer.clickScreen')
                          : t('computer.computerScreen')
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
                        alt={`${t('computer.liveBrowserFor')} ${dot.name}`}
                      />
                    </button>
                    <small>
                      {t('computer.refreshed')}{' '}
                      {new Date(screen.capturedAt).toLocaleTimeString('pt-BR')}.{' '}
                      {t('computer.panelUpdates')}
                    </small>
                  </>
                ) : (
                  <p className="computer-screen-empty">
                    {running && status.permissions.browser
                      ? t('computer.waitingScreen')
                      : t('computer.startWithBrowser')}
                  </p>
                )}
                <div className="computer-control-pill">
                  <span>
                    {human
                      ? t('computer.humanControl')
                      : `${dot.name} está no controle`}
                  </span>
                  <button
                    disabled={
                      (!human && !browser) ||
                      busy ||
                      status.control?.transitioning
                    }
                    onClick={() => void run(human ? '/release' : '/take')}
                  >
                    {human
                      ? t('computer.returnControl')
                      : t('computer.takeControl')}
                  </button>
                </div>
                {status.control?.transitioning && (
                  <p role="status">{t('computer.transferring')}</p>
                )}
                {human && (
                  <details className="computer-human">
                    <summary>{t('computer.preciseControls')}</summary>
                    <p>{t('computer.humanInstructions')}</p>
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
                        {t('computer.click')}
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
                        aria-label={t('computer.textToType')}
                        placeholder={t('computer.typePlaceholder')}
                        autoComplete="off"
                        value={text}
                        maxLength={20000}
                        onChange={(event) => setText(event.target.value)}
                      />
                      <button disabled={busy || !browser || !text}>
                        {t('computer.type')}
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
                        aria-label={t('computer.keyToPress')}
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
                        {t('computer.pressKey')}
                      </button>
                    </form>
                    <div className="computer-actions">
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: -500 })
                        }
                      >
                        Scroll up
                      </button>
                      <button
                        disabled={busy || !browser}
                        onClick={() =>
                          void action('human_scroll', { deltaY: 500 })
                        }
                      >
                        Scroll down
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
                <summary>{t('computer.files')}</summary>
                <p>{t('computer.filePaths')}</p>
                <label>
                  {t('computer.path')}
                  <input
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder="notes.txt"
                    disabled={!running || !status.permissions.files || busy}
                  />
                </label>
                <div className="computer-actions">
                  <button
                    disabled={!running || !status.permissions.files || busy}
                    onClick={() => void action('files_list', { path }, true)}
                  >
                    {t('computer.listFilesButton')}
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
                    {t('computer.readFileButton')}
                  </button>
                </div>
                <label>
                  {t('computer.fileContents')}
                  <textarea
                    aria-label={t('computer.saveContents')}
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
                  {t('computer.replaceFile')}
                </button>
                {!status.permissions.files && (
                  <p>{t('computer.workspaceFilesPermission')}</p>
                )}
              </details>
              <details
                className="computer-section"
                open
                hidden={tab !== 'Terminal'}
              >
                <summary>{t('computer.terminal')}</summary>
                <p>{t('computer.terminalInstructions')}</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action('exec', { command, timeoutMs: 30000 }, true);
                  }}
                >
                  <textarea
                    aria-label={t('computer.terminalCommand')}
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
                    {t('computer.runCommandButton')}
                  </button>
                </form>
                {!status.permissions.shell && (
                  <p>{t('computer.terminalPermission')}</p>
                )}
              </details>
              {(output || outputError) &&
                (tab === 'Files' || tab === 'Terminal') && (
                  <section className="computer-section">
                    <h3>{t('computer.output')}</h3>
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
                      {t('computer.clearOutput')}
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
            <summary>{t('computer.recentActivity')}</summary>
            {status.audit.length ? (
              <ol className="computer-audit">
                {status.audit
                  .slice(-30)
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id}>
                      <strong>
                        {actionLabels[entry.action] ??
                          t('computer.unknownAction')}
                      </strong>
                      <span>
                        {entry.actor === 'owner'
                          ? t('computer.auditOwner')
                          : t('computer.auditAgent')}{' '}
                        ·{' '}
                        {entry.outcome === 'succeeded'
                          ? t('computer.auditSuccess')
                          : entry.outcome === 'failed'
                            ? t('computer.auditFailed')
                            : t('computer.auditPending')}{' '}
                        ·{' '}
                        {new Date(entry.createdAt).toLocaleTimeString('pt-BR')}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p>{t('computer.noActions')}</p>
            )}
          </details>
          <details className="computer-settings">
            <summary>{t('computer.settings')}</summary>{' '}
            <details
              className="computer-permissions"
              open={!status.permissions.enabled}
            >
              <summary>{t('computer.permissions')}</summary>
              <p>
                {t('computer.choosePermissions').replace('{name}', dot.name)}
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
                        enabled: t('computer.enable'),
                        browser: t('computer.browser'),
                        files: t('computer.files'),
                        shell: t('computer.shell'),
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
                {t('computer.startComputer')}
              </button>
              <button
                disabled={busy || status.state !== 'running'}
                onClick={() => void run('/stop')}
              >
                {t('computer.stopComputer')}
              </button>
            </div>
            <p className="computer-hint">{t('computer.stopInfo')}</p>
          </details>
        </>
      )}
    </section>
  );
}
