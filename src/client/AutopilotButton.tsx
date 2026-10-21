import { useCallback, useEffect, useState } from 'react';
import { Plane } from 'lucide-react';
import { api, ApiError } from './api';

type Mode = 'off' | 'dry_run' | 'live';
type Status = {
  state: { mode: Mode; until?: number; note?: string };
  pin_set: boolean;
  record: Record<
    string,
    {
      scored: number;
      win_rate: number | null;
      profit_per_trade: number | null;
      qualified: boolean;
    }
  >;
  minimum: { scored: number; win_rate: number };
  open: { id: string; kind: string; ticker: string; entry: number }[];
  orders: {
    ts: number;
    trade: string;
    side: string;
    mode: string;
    result: string;
  }[];
  picks?: {
    days?: {
      day: string;
      picks: number;
      wins: number;
      open: number;
      pnl: number;
    }[];
    error?: string;
  };
  error?: string;
};

const LABEL: Record<Mode, string> = {
  off: 'Off',
  dry_run: 'Dry run',
  live: 'LIVE',
};

function time(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The Robinhood autopilot switch. Turning it on takes the owner's PIN (checked
// by localtools/autopilot.py); live trading also needs a kind with the
// minimum record. Turning it off takes nothing.
export function AutopilotButton() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'dry_run' | 'live'>('dry_run');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>('/autopilot'));
    } catch {
      // Server restarting: the next tick tries again.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const send = async (on: boolean) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await api<Status>('/autopilot', 'POST', { on, mode, pin }));
      setPin('');
      if (on) setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'Could not reach it.',
      );
    } finally {
      setBusy(false);
    }
  };

  const current = status?.state.mode ?? 'off';
  const qualified = Object.entries(status?.record ?? {}).filter(
    ([, r]) => r.qualified,
  );

  return (
    <div className="autopilot">
      <button
        className={`autopilot-button autopilot-${current}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Plane size={14} />
        <span>
          Autopilot: {LABEL[current]}
          {status?.state.until ? ` until ${time(status.state.until)}` : ''}
        </span>
      </button>
      {open && status && (
        <div className="autopilot-panel" role="dialog" aria-label="Autopilot">
          <p className="autopilot-explain">
            Runs the options strategy on Robinhood while you are away: it opens
            trades within your rules and closes them at the profit target, stop
            or trailing stop. It turns itself off at 4pm.
          </p>
          {status.state.note && (
            <p className="autopilot-note">{status.state.note}</p>
          )}
          {current !== 'off' ? (
            <button
              className="autopilot-off"
              disabled={busy}
              onClick={() => void send(false)}
            >
              Turn autopilot off
            </button>
          ) : !status.pin_set ? (
            <p className="autopilot-note">
              Set your PIN first, from a terminal on the PC:
              <code>
                localtools\.venv\Scripts\python.exe localtools\autopilot.py
                set-pin
              </code>
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(true);
              }}
            >
              <label>
                <input
                  type="radio"
                  checked={mode === 'dry_run'}
                  onChange={() => setMode('dry_run')}
                />
                Dry run: everything up to the review screen, then it stops
              </label>
              <label className={qualified.length ? '' : 'autopilot-disabled'}>
                <input
                  type="radio"
                  disabled={!qualified.length}
                  checked={mode === 'live'}
                  onChange={() => setMode('live')}
                />
                Live: it submits the orders
                {qualified.length
                  ? ` (${qualified.map(([kind]) => kind).join(', ')})`
                  : ' (no trade type has the minimum record yet)'}
              </label>
              <input
                className="autopilot-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="PIN"
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, ''))
                }
              />
              <button type="submit" disabled={busy || pin.length < 6}>
                Turn on {mode === 'live' ? 'LIVE' : 'dry run'}
              </button>
            </form>
          )}
          {error && <p className="autopilot-error">{error}</p>}
          <table className="autopilot-record">
            <caption>
              Minimum record for live: {status.minimum.scored} scored,{' '}
              {Math.round(status.minimum.win_rate * 100)}% wins, profit per
              trade above $0
            </caption>
            <tbody>
              {Object.entries(status.record).map(([kind, r]) => (
                <tr key={kind}>
                  <td>{kind}</td>
                  <td>{r.scored} scored</td>
                  <td>
                    {r.win_rate == null
                      ? '-'
                      : `${Math.round(r.win_rate * 100)}%`}
                  </td>
                  <td>
                    {r.profit_per_trade == null
                      ? '-'
                      : `$${r.profit_per_trade.toFixed(2)}`}
                  </td>
                  <td>{r.qualified ? 'ready' : 'not yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!status.picks?.days?.length && (
            <table className="autopilot-record">
              <caption>
                How its picks did (dry run: would have done), managed by the
                rules
              </caption>
              <tbody>
                {status.picks.days.slice(0, 7).map((day) => (
                  <tr key={day.day}>
                    <td>{day.day}</td>
                    <td>
                      {day.picks} pick{day.picks === 1 ? '' : 's'}
                    </td>
                    <td>
                      {day.wins} of {day.picks - day.open} won
                    </td>
                    <td>
                      {day.pnl >= 0 ? '+' : '-'}${Math.abs(day.pnl).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {status.orders.length > 0 && (
            <ul className="autopilot-orders">
              {status.orders.slice(0, 5).map((order) => (
                <li key={`${order.ts}`}>
                  {time(order.ts)} {order.side} {order.trade}: {order.result} (
                  {order.mode})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
