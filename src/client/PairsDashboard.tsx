import { useEffect, useState } from 'react';
import { api } from './api';

export interface PairRow {
  pair: string;
  payout: number | null;
  trend: string;
  score: number;
  rsi14: number | null;
  macd: string | null;
  ema9_slope?: string | null;
  recent_candles?: string;
  /** A MACD cross after a run one way, with RSI beyond 70/30 for a reversal. */
  signal?: string;
}
export interface PairScan {
  time?: number;
  market?: string;
  now_on?: string;
  best?: PairRow | null;
  pairs?: PairRow[];
  note?: string;
}

const arrow = (trend: string) =>
  trend === 'up'
    ? '▲ up'
    : trend === 'down'
      ? '▼ down'
      : trend === 'warming up'
        ? '… too few candles'
        : '– none';

// Pairs at a glance under the live view: the latest scan (the owner's or a
// Dot's), a button to scan again, and a click on a pair to switch to it. Both
// go through the same local tools the Dots use, one action at a time.
export function PairsDashboard({ onError }: { onError: (m: string) => void }) {
  const [scan, setScan] = useState<PairScan>({});
  const [busy, setBusy] = useState('');
  // A pair switched here, until a newer scan reports where the chart is.
  const [chosen, setChosen] = useState<{ pair: string; at: number }>();
  // Obvious turns only (MACD cross after a run, RSI beyond 70/30) vs every clear trend.
  const [obvious, setObvious] = useState<boolean>();
  useEffect(() => {
    api<{ obviousOnly: boolean }>('/browser/trading-mode')
      .then((mode) => setObvious(mode.obviousOnly))
      .catch(() => undefined);
  }, []);
  const load = () =>
    api<PairScan>('/browser/pairs')
      .then(setScan)
      .catch(() => undefined);
  useEffect(() => {
    void load();
    // A Dot's scans show up too.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);
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
  const current =
    chosen && (!scan.time || chosen.at > scan.time) ? chosen.pair : scan.now_on;
  const age = scan.time
    ? Math.max(0, Math.round(Date.now() / 1000 - scan.time))
    : undefined;
  return (
    <section className="pairs-dashboard" aria-label="Pairs">
      <div className="pairs-head">
        <strong>Pairs</strong>
        <span className="muted">
          {busy
            ? busy
            : age === undefined
              ? 'Not scanned yet.'
              : `Scanned ${age < 90 ? `${age}s` : `${Math.round(age / 60)}m`} ago${scan.market ? ` (${scan.market} pairs)` : ''}${current ? `; chart on ${current}` : ''}.`}
        </span>
        <button
          type="button"
          className={`text-button pairs-mode ${obvious ? 'on' : ''}`}
          title="On: trade only obvious turns (MACD cross after a run, RSI beyond 70/30) and keep scanning for them. Off: trade every clear trend."
          disabled={obvious === undefined}
          aria-pressed={!!obvious}
          onClick={() =>
            void act('Switching mode…', async () => {
              const mode = await api<{ obviousOnly: boolean }>(
                '/browser/trading-mode',
                'POST',
                { obviousOnly: !obvious },
              );
              setObvious(mode.obviousOnly);
            })
          }
        >
          Obvious turns only: {obvious ? 'On' : 'Off'}
        </button>
        {(['otc', 'real'] as const).map((market) => (
          <button
            key={market}
            type="button"
            className="text-button"
            title={
              market === 'otc'
                ? 'Rate the top OTC pairs'
                : 'Rate the top real (non-OTC) pairs, for trades of 1 minute or more'
            }
            disabled={!!busy}
            onClick={() =>
              void act(
                `Scanning about 8 ${market === 'otc' ? 'OTC' : 'real'} pairs (2 s each)…`,
                () => api('/browser/pairs/scan', 'POST', { count: 8, market }),
              )
            }
          >
            {market === 'otc' ? 'Scan OTC' : 'Scan real pairs'}
          </button>
        ))}
      </div>
      {scan.pairs?.length ? (
        <table>
          <thead>
            <tr>
              <th>Pair</th>
              <th>Payout</th>
              <th>Trend</th>
              <th>RSI</th>
              <th>MACD</th>
              <th>Candles</th>
            </tr>
          </thead>
          <tbody>
            {scan.pairs.map((row) => (
              <tr
                key={row.pair}
                className={`${row.pair === current ? 'current' : ''} ${row.trend}`}
              >
                <td>
                  <button
                    type="button"
                    className="text-button"
                    title={`Switch the chart to ${row.pair}`}
                    disabled={!!busy || row.pair === current}
                    onClick={() =>
                      void act(`Switching to ${row.pair}…`, async () => {
                        await api('/browser/pairs/choose', 'POST', {
                          name: row.pair,
                        });
                        setChosen({ pair: row.pair, at: Date.now() / 1000 });
                      })
                    }
                  >
                    {row.pair}
                  </button>
                </td>
                <td>{row.payout === null ? '' : `${row.payout}%`}</td>
                <td title={row.signal}>
                  {arrow(row.trend)}
                  {row.signal
                    ? row.signal.includes('Bollinger')
                      ? ' ★ top setup'
                      : row.signal.includes('RSI above') ||
                          row.signal.includes('RSI below')
                        ? ' ↺ reversal'
                        : ' ↺ cross'
                    : ''}
                </td>
                <td>{row.rsi14 ?? ''}</td>
                <td>{row.macd ?? ''}</td>
                <td className="pairs-candles">{row.recent_candles ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
