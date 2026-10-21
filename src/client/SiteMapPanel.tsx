import { useEffect, useState } from 'react';
import { api } from './api';

interface Routine {
  name: string;
  params: string[];
  description: string;
  steps: unknown[];
  last_run?: { result: string; step?: number; error?: string };
}
interface SiteMap {
  site: string | null;
  start_url?: string;
  targets?: { name: string; kind?: string; page?: string; status?: string }[];
  routines?: Routine[];
  notes_folder?: string;
}
interface Recorded {
  recording: string | null;
  steps: { do: string; label?: string; text?: string }[];
}

/**
 * The site map of the page on screen: its routines (run with fill-ins, forget),
 * recording a new routine from the owner's own clicks and typing, and renaming
 * the site. The map itself is kept as Obsidian notes, one folder per site.
 */
export function SiteMapPanel({
  url,
  takeover,
  onTakeover,
  onError,
}: {
  url: string;
  takeover: boolean;
  onTakeover: (on: boolean) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [map, setMap] = useState<SiteMap>({ site: null });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [running, setRunning] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState('');
  const [recordName, setRecordName] = useState('');
  const [fillIns, setFillIns] = useState('');
  const [recording, setRecording] = useState<Recorded>();
  const [renaming, setRenaming] = useState('');

  const load = () =>
    api<SiteMap>('/browser/sitemap')
      .then(setMap)
      .catch(() => setMap({ site: null }));
  useEffect(() => {
    void load();
  }, [url]);
  // While recording, show the steps as they are taken.
  useEffect(() => {
    if (!recording?.recording) return;
    const timer = setInterval(
      () =>
        void api<Recorded>('/browser/routine/record', 'POST', {
          action: 'poll',
        })
          .then(setRecording)
          .catch(() => undefined),
      1500,
    );
    return () => clearInterval(timer);
  }, [recording?.recording]);

  const act = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    onError('');
    try {
      await work();
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusy('');
    }
  };
  const routines = map.routines ?? [];
  const targets = map.targets ?? [];

  return (
    <section className="site-map">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {map.site
          ? `Site map: ${map.site} (${targets.length} taught, ${routines.length} routines)`
          : 'Site map: nothing mapped on this site yet'}
      </button>
      {open && (
        <div className="site-map-body">
          {map.site &&
            (renaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('rename', async () => {
                    await api('/browser/site/rename', 'POST', {
                      site: map.site,
                      newName: renaming,
                    });
                    setRenaming('');
                  });
                }}
              >
                <input
                  aria-label="Site name"
                  value={renaming}
                  maxLength={80}
                  onChange={(e) => setRenaming(e.target.value)}
                />
                <button className="primary" disabled={!!busy}>
                  Rename
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRenaming('')}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <p className="muted">
                Start page {map.start_url}.{' '}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRenaming(map.site ?? '')}
                >
                  Rename site
                </button>
              </p>
            ))}
          {routines.map((routine) => (
            <div key={routine.name} className="site-routine">
              <div className="site-routine-head">
                <strong>{routine.name}</strong>
                <span className="muted">
                  {routine.steps.length} steps
                  {routine.last_run
                    ? `, last run ${routine.last_run.result}${routine.last_run.step ? ` at step ${routine.last_run.step}` : ''}`
                    : ''}
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={!!busy || takeover}
                  title={takeover ? 'Hand control back to run it' : undefined}
                  onClick={() =>
                    routine.params.length && running !== routine.name
                      ? setRunning(routine.name)
                      : void act(routine.name, async () => {
                          const done = await api<{
                            result: string;
                            failed_step?: number;
                            error?: string;
                          }>('/browser/routine/run', 'POST', {
                            name: routine.name,
                            values,
                          });
                          setRunning(undefined);
                          setResult(
                            done.result === 'completed'
                              ? `${routine.name}: done.`
                              : `${routine.name}: stopped at step ${done.failed_step}. ${done.error ?? ''}`,
                          );
                        })
                  }
                >
                  {busy === routine.name ? 'Running…' : 'Run'}
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Forget routine ${routine.name}`}
                  disabled={!!busy}
                  onClick={() =>
                    void act('forget', () =>
                      api('/browser/routine/forget', 'POST', {
                        name: routine.name,
                      }),
                    )
                  }
                >
                  ×
                </button>
              </div>
              {routine.description && (
                <span className="muted">{routine.description}</span>
              )}
              {running === routine.name && (
                <div className="site-routine-fill">
                  {routine.params.map((param) => (
                    <input
                      key={param}
                      aria-label={param}
                      placeholder={param}
                      value={values[param] ?? ''}
                      onChange={(e) =>
                        setValues({ ...values, [param]: e.target.value })
                      }
                    />
                  ))}
                  <span className="muted">then press Run</span>
                </div>
              )}
            </div>
          ))}
          {result && (
            <p className="muted" role="status">
              {result}
            </p>
          )}
          {recording?.recording ? (
            <div className="site-record">
              <span role="status">
                Recording “{recording.recording}”: do the task in the view
                above.
              </span>
              <ol>
                {recording.steps.map((step, i) => (
                  <li key={i}>
                    {step.do} {step.label ? `“${step.label}”` : ''}
                    {step.text ? ` → ${step.text}` : ''}
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void act('finish', async () => {
                    const saved = await api<{
                      saved: string;
                      params: string[];
                    }>('/browser/routine/record', 'POST', { action: 'finish' });
                    setRecording(undefined);
                    setResult(
                      `Saved “${saved.saved}”${saved.params.length ? ` with fill-ins ${saved.params.join(', ')}` : ''}.`,
                    );
                    if (takeover) await onTakeover(false);
                  })
                }
              >
                Finish and save
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void act('discard', async () => {
                    await api('/browser/routine/record', 'POST', {
                      action: 'discard',
                    });
                    setRecording(undefined);
                    if (takeover) await onTakeover(false);
                  })
                }
              >
                Discard
              </button>
            </div>
          ) : (
            <form
              className="site-record-start"
              onSubmit={(e) => {
                e.preventDefault();
                // "pair=EURUSD, qty=1": typed text equal to an example becomes {pair}.
                const examples = Object.fromEntries(
                  fillIns
                    .split(',')
                    .map((part) => part.split('=').map((s) => s.trim()))
                    .filter(([k, v]) => k && v),
                );
                void act('record', async () => {
                  const started = await api<{ recording: string }>(
                    '/browser/routine/record',
                    'POST',
                    { action: 'start', name: recordName, fillIns: examples },
                  );
                  if (!takeover) await onTakeover(true);
                  setRecording({ recording: started.recording, steps: [] });
                  setRecordName('');
                  setFillIns('');
                });
              }}
            >
              <input
                aria-label="Routine name"
                placeholder="New routine, e.g. Open pair"
                maxLength={80}
                value={recordName}
                onChange={(e) => setRecordName(e.target.value)}
              />
              <input
                aria-label="Fill-ins with examples"
                placeholder="Fill-ins, e.g. pair=EURUSD"
                value={fillIns}
                onChange={(e) => setFillIns(e.target.value)}
              />
              <button
                className="primary"
                disabled={!!busy || !recordName.trim()}
              >
                Record
              </button>
            </form>
          )}
          {map.notes_folder && (
            <p className="muted">Notes: {map.notes_folder}</p>
          )}
        </div>
      )}
    </section>
  );
}
