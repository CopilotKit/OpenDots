import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe,
  Hand,
  RotateCw,
} from 'lucide-react';
import { api, authHeaders } from './api';
import { PairsDashboard } from './PairsDashboard';
import { SiteMapPanel } from './SiteMapPanel';

interface Frame {
  data: string;
  url: string;
  width: number;
  height: number;
  takeover: boolean;
}
interface Taught {
  id: string;
  name: string;
  kind?: string;
  /** Taught on another page of the site; used here only if found. */
  elsewhere?: boolean;
}
interface Status {
  running: boolean;
  url: string;
  title: string;
  takeover: boolean;
}
const specialKeys = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

// Live view of the Dots' own browser. The owner can watch the agent, navigate,
// and take control (their clicks, scrolling and typing go to the page while the
// agent's browser tools wait), then hand control back.
export function BrowserPanel() {
  const [status, setStatus] = useState<Status>();
  const [frame, setFrame] = useState<Frame>();
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [error, setError] = useState('');
  const wheel = useRef(0);
  // The status is refreshed after every action; a still page sends no new
  // frames, so the last frame's copy can be stale after a takeover change.
  const takeover = status?.takeover ?? frame?.takeover ?? false;
  // Owner teaching: name a button, click it in the view, confirm it in the page.
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachName, setTeachName] = useState('');
  const [teachKind, setTeachKind] = useState<'button' | 'region'>('button');
  // For buttons that only appear after another click (Double Up after BUY).
  const [teachAfter, setTeachAfter] = useState(false);
  const [teaching, setTeaching] = useState<{
    name: string;
    tookControl: boolean;
    after?: boolean;
    kind?: 'button' | 'region';
  }>();
  const [teachStep, setTeachStep] = useState('');
  const [taught, setTaught] = useState<Taught[]>([]);
  const finishing = useRef(false);

  const refresh = () =>
    api<Status>('/browser/status')
      .then(setStatus)
      .catch(() => undefined);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!editing && frame?.url) setAddress(frame.url);
  }, [frame?.url, editing]);
  const loadTaught = () =>
    api<{ targets?: Taught[] }>('/browser/targets')
      .then((result) =>
        setTaught((result.targets ?? []).filter((t) => !t.elsewhere)),
      )
      .catch(() => setTaught([]));
  useEffect(() => {
    if (status?.running && !teaching) void loadTaught();
    // Reload when the page on screen changes.
  }, [status?.running, frame?.url, teaching]);
  const endTeaching = async (message: string) => {
    const tookControl = teaching?.tookControl;
    setTeaching(undefined);
    setTeachStep(message);
    if (tookControl)
      await api('/browser/takeover', 'POST', { on: false }).catch(
        () => undefined,
      );
    await refresh();
  };
  // Follow the in-page teaching steps and save once the owner confirms.
  useEffect(() => {
    if (!teaching) return;
    const timer = setInterval(() => {
      void (async () => {
        const state = await api<{
          status?: string;
          captured_label?: string;
          clicks_to_let_through?: number;
        }>('/browser/teach').catch(() => undefined);
        if (!state || finishing.current) return;
        if (state.status === 'waiting_for_owner' && teaching.after)
          setTeachStep(
            state.clicks_to_let_through
              ? `Click the button that makes "${teaching.name}" appear (for example BUY); that click goes through as normal.`
              : `Now click "${teaching.name}" quickly to mark it (it is not pressed), then click "Confirm taught target" in the page.`,
          );
        else if (state.status === 'marked_not_confirmed')
          setTeachStep(
            `Marked${state.captured_label ? ` "${state.captured_label}"` : ''}. Now click "Confirm taught target" in the page to save it as "${teaching.name}".`,
          );
        else if (state.status === 'confirmed_not_saved') {
          finishing.current = true;
          try {
            await api('/browser/teach/finish', 'POST', {});
            await endTeaching(
              `Saved "${teaching.name}". Your Dots will use it by name on this page.`,
            );
          } catch (e) {
            await endTeaching(
              e instanceof Error ? e.message : 'Saving the button failed.',
            );
          } finally {
            finishing.current = false;
          }
        } else if (
          state.status === 'cancelled_or_expired' ||
          state.status === 'not_started'
        )
          await endTeaching(
            'Teaching was cancelled, timed out (2 minutes) or the page changed. Nothing was saved.',
          );
      })();
    }, 1000);
    return () => clearInterval(timer);
  }, [teaching]);
  const startTeaching = () =>
    void run(async () => {
      const name = teachName.trim();
      if (!name) return;
      const after = teachKind === 'button' && teachAfter;
      await api('/browser/teach', 'POST', {
        name,
        kind: teachKind,
        afterClicks: after ? 1 : 0,
      });
      // The owner's clicks reach the page only while they have control.
      const tookControl = !takeover;
      if (tookControl) await api('/browser/takeover', 'POST', { on: true });
      setTeaching({ name, tookControl, after, kind: teachKind });
      setTeachAfter(false);
      setTeachOpen(false);
      setTeachName('');
      setTeachStep(
        after
          ? `Click the button that makes "${name}" appear (for example BUY); that click goes through as normal. Then click "${name}" quickly to mark it.`
          : teachKind === 'region'
            ? `Drag a box around "${name}" in the view below, then click "Confirm taught target" in the page.`
            : `Click "${name}" in the view below to mark it (it is not pressed), then click "Confirm taught target" in the page.`,
      );
    });

  // Frames arrive as server-sent events over fetch (so auth headers apply).
  useEffect(() => {
    if (!status?.running) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/browser/stream', {
          headers: authHeaders(),
          signal: controller.signal,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) setFrame(JSON.parse(data) as Frame);
          }
        }
      } catch {
        // Stream closed (tab hidden, browser closed or server restart).
      }
    })();
    return () => controller.abort();
  }, [status?.running]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Browser action failed.');
    } finally {
      setBusy(false);
    }
  };
  const send = (event: Record<string, unknown>) =>
    api('/browser/input', 'POST', event).catch((e) =>
      setError(e instanceof Error ? e.message : 'Input failed.'),
    );
  const point = (event: React.MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * (frame?.width ?? 0),
      y: ((event.clientY - box.top) / box.height) * (frame?.height ?? 0),
    };
  };
  // One pointer gesture on the view (mouse, finger or pen): a tap is a click; a
  // drag is sent whole at release (drawing a taught region, or a mouse drag); a
  // finger swipe otherwise scrolls the page, since phones have no wheel.
  const gesture = useRef<{
    id: number;
    touch: boolean;
    start: { x: number; y: number };
    last: { x: number; y: number };
    points: { x: number; y: number }[];
  }>(undefined);
  const [drawBox, setDrawBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const drawing = teaching?.kind === 'region';
  // A desktop page shrunk to a phone screen is too small to tap: zoom the view.
  // Zoomed, one finger pans the view (a tap still clicks); at 1x a swipe
  // scrolls the page. Drawing a region always draws.
  const [zoom, setZoom] = useState(1);
  // Phones cannot type into the live view: a text box sends text to the page.
  const [typed, setTyped] = useState('');
  const viewBox = (
    img: HTMLImageElement,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    const view = img.parentElement!;
    const rect = view.getBoundingClientRect();
    const left = Math.min(a.x, b.x) - rect.left + view.scrollLeft;
    const top = Math.min(a.y, b.y) - rect.top + view.scrollTop;
    return {
      left,
      top,
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!takeover || e.button !== 0) return;
    e.currentTarget.parentElement?.focus();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture only keeps the drag when the finger leaves the view.
    }
    const at = { x: e.clientX, y: e.clientY };
    gesture.current = {
      id: e.pointerId,
      touch: e.pointerType !== 'mouse',
      start: at,
      last: at,
      points: [point(e)],
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const at = { x: e.clientX, y: e.clientY };
    if (Math.hypot(at.x - g.last.x, at.y - g.last.y) < 4) return;
    g.last = at;
    g.points.push(point(e));
    if (drawing) setDrawBox(viewBox(e.currentTarget, g.start, at));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = undefined;
    setDrawBox(undefined);
    const end = { x: e.clientX, y: e.clientY };
    if (Math.hypot(end.x - g.start.x, end.y - g.start.y) < 8) {
      void send({ type: 'click', ...g.points[0] });
      return;
    }
    const points = [...g.points, point(e)];
    if (drawing || !g.touch) {
      // At most 60 points, spread evenly along the drag.
      const step = Math.max(1, (points.length - 1) / 59);
      const kept = Array.from(
        { length: Math.min(60, points.length) },
        (_, i) => points[Math.min(points.length - 1, Math.round(i * step))],
      );
      void send({ type: 'drag', points: kept });
      return;
    }
    if (zoom > 1) return; // The swipe panned the zoomed view.
    const scale =
      (frame?.width ?? 0) / e.currentTarget.getBoundingClientRect().width || 1;
    const clamp = (v: number) => Math.max(-5000, Math.min(5000, Math.round(v)));
    void send({
      type: 'wheel',
      dx: clamp((g.start.x - end.x) * scale),
      dy: clamp((g.start.y - end.y) * scale),
    });
  };
  const onPointerCancel = () => {
    gesture.current = undefined;
    setDrawBox(undefined);
  };
  // Some sign-ins (e.g. Google) refuse any remotely controlled browser. This
  // opens the same profile in a plain window; logins carry over to the Dots.
  const signIn = (
    <div className="browser-signin">
      {signInOpen ? (
        <span>
          A plain Chrome window opened on the Dots&apos; profile. Sign in there,
          close that window, then start the browser again.
        </span>
      ) : (
        <>
          <span>Site won&apos;t let you sign in here?</span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api('/browser/signin', 'POST', {
                  url:
                    address && !address.startsWith('about:')
                      ? address
                      : 'https://accounts.google.com',
                });
                setSignInOpen(true);
              })
            }
          >
            Sign in normally
          </button>
        </>
      )}
    </div>
  );
  if (!status) return <p className="computer-panel">Checking the browser…</p>;
  if (!status.running)
    return (
      <div className="browser-panel browser-empty">
        <Globe size={28} />
        <p>
          Your Dots have their own browser window. Start it here, or ask a Dot
          with the Web browser tool to open a site.
        </p>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api('/browser/start', 'POST', { url: 'https://duckduckgo.com' }),
            )
          }
        >
          {busy ? 'Starting…' : 'Start browser'}
        </button>
        {signIn}
        {error && <p className="chat-error">{error}</p>}
      </div>
    );

  return (
    <div className="browser-panel">
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          void run(() => api('/browser/navigate', 'POST', { url: address }));
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label="Back"
          onClick={() =>
            void run(() => api('/browser/navigate', 'POST', { action: 'back' }))
          }
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Forward"
          onClick={() =>
            void run(() =>
              api('/browser/navigate', 'POST', { action: 'forward' }),
            )
          }
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          onClick={() =>
            void run(() =>
              api('/browser/navigate', 'POST', { action: 'reload' }),
            )
          }
        >
          <RotateCw size={15} />
        </button>
        <input
          aria-label="Address"
          value={address}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button
          type="button"
          className={`browser-control ${takeover ? 'owner' : ''}`}
          onClick={() =>
            void run(() => api('/browser/takeover', 'POST', { on: !takeover }))
          }
        >
          {takeover ? <Bot size={14} /> : <Hand size={14} />}
          {takeover ? 'Hand back' : 'Take control'}
        </button>
        <button
          type="button"
          className="browser-control"
          aria-label="Zoom the live view"
          title="Zoom the live view (for tapping small buttons on a phone)"
          onClick={() => setZoom((z) => (z >= 3 ? 1 : z + 1))}
        >
          {zoom}×
        </button>
      </form>
      <div
        className={`browser-view ${takeover ? 'owner' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!takeover) return;
          const combo = e.ctrlKey || e.metaKey || e.altKey;
          if (combo && e.key.length === 1) {
            e.preventDefault();
            void send({
              type: 'key',
              key: `${e.ctrlKey ? 'Control+' : ''}${e.altKey ? 'Alt+' : ''}${e.metaKey ? 'Meta+' : ''}${e.key}`,
            });
          } else if (specialKeys.has(e.key)) {
            e.preventDefault();
            void send({ type: 'key', key: e.key });
          } else if (e.key.length === 1) {
            e.preventDefault();
            void send({ type: 'text', text: e.key });
          }
        }}
        onPaste={(e) => {
          if (!takeover) return;
          const text = e.clipboardData.getData('text');
          if (text) void send({ type: 'text', text: text.slice(0, 2000) });
        }}
      >
        {frame ? (
          <img
            alt={`Live view of ${frame.url}`}
            src={`data:image/jpeg;base64,${frame.data}`}
            draggable={false}
            style={{
              width: `${zoom * 100}%`,
              touchAction: !takeover
                ? undefined
                : zoom === 1 || drawing
                  ? 'none'
                  : 'pan-x pan-y',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={(e) => {
              if (!takeover) return;
              e.preventDefault();
              void send({ type: 'click', button: 'right', ...point(e) });
            }}
            onWheel={(e) => {
              if (!takeover) return;
              wheel.current += e.deltaY;
              if (Math.abs(wheel.current) < 60) return;
              void send({ type: 'wheel', dx: 0, dy: wheel.current });
              wheel.current = 0;
            }}
          />
        ) : (
          <p className="muted">Connecting to the live view…</p>
        )}
        {drawBox && <span className="browser-draw" style={drawBox} />}
        <span className={`browser-badge ${takeover ? 'owner' : ''}`}>
          {takeover
            ? 'You have control. Dots are waiting.'
            : 'Dots are in control. Watching live.'}
        </span>
      </div>
      {takeover && (
        <form
          className="browser-type"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed) void send({ type: 'text', text: typed });
            setTyped('');
          }}
        >
          <input
            aria-label="Type into the page"
            placeholder="Type into the page"
            value={typed}
            maxLength={2000}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="browser-control" disabled={!typed}>
            Type
          </button>
          <button
            type="button"
            className="browser-control"
            onClick={() => void send({ type: 'key', key: 'Enter' })}
          >
            Enter
          </button>
        </form>
      )}
      <div className="browser-teach">
        {teaching ? (
          <>
            <span role="status">{teachStep}</span>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void run(async () => {
                  await api('/browser/teach/cancel', 'POST', {}).catch(
                    () => undefined,
                  );
                  await endTeaching('Teaching cancelled. Nothing was saved.');
                })
              }
            >
              Cancel
            </button>
          </>
        ) : teachOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTeaching();
            }}
          >
            <input
              aria-label="Name of the button to teach"
              placeholder="Name, e.g. BUY"
              maxLength={160}
              value={teachName}
              onChange={(e) => setTeachName(e.target.value)}
            />
            <select
              aria-label="What to teach"
              value={teachKind}
              onChange={(e) =>
                setTeachKind(e.target.value as 'button' | 'region')
              }
            >
              <option value="button">Button</option>
              <option value="region">Chart area</option>
            </select>
            {teachKind === 'button' && (
              <label className="browser-teach-after">
                <input
                  type="checkbox"
                  checked={teachAfter}
                  onChange={(e) => setTeachAfter(e.target.checked)}
                />
                Appears after another click
              </label>
            )}
            <button className="primary" disabled={busy || !teachName.trim()}>
              Start
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setTeachOpen(false)}
            >
              Close
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setTeachOpen(true);
              setTeachStep('');
            }}
          >
            Teach a button
          </button>
        )}
        {!teaching && teachStep && (
          <span className="muted" role="status">
            {teachStep}
          </span>
        )}
        {taught.length > 0 && (
          <span className="browser-taught">
            Saved here:
            {taught.map((target) => (
              <span key={target.id} className="browser-chip">
                {target.name}
                {target.kind && target.kind !== 'button'
                  ? ` (${target.kind === 'region' ? 'area' : target.kind})`
                  : ''}
                <button
                  type="button"
                  aria-label={`Forget ${target.name}`}
                  disabled={busy || !!teaching}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/browser/targets/${encodeURIComponent(target.id)}/forget`,
                        'POST',
                        {},
                      );
                      await loadTaught();
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      {status?.running && (
        <SiteMapPanel
          url={frame?.url ?? status.url}
          takeover={takeover}
          onTakeover={async (on) => {
            await api('/browser/takeover', 'POST', { on });
            await refresh();
          }}
          onError={setError}
        />
      )}
      {/pocketoption\.com/.test(frame?.url ?? status?.url ?? '') && (
        <PairsDashboard onError={setError} />
      )}
      {signIn}
      {error && <p className="chat-error">{error}</p>}
    </div>
  );
}
