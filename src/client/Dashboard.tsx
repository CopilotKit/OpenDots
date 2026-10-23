import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CalendarClock,
  CandlestickChart,
  Gauge,
  Radar,
  RefreshCw,
  Trophy,
  Zap,
} from 'lucide-react';
import { api } from './api';

type Edge = {
  vix?: number;
  vix_avg20?: number;
  vix_vs_20d?: number;
  ma20?: number;
  ma20_z?: number;
  price?: number;
  fading_fear?: boolean;
  stretched?: boolean;
  error?: string;
};
type Pick = {
  day: string;
  time: string;
  ticker: string;
  kind: string;
  mode: string;
  price: number;
  pnl: number | null;
  how: string;
};
type Record_ = {
  scored: number;
  win_rate: number | null;
  profit_per_trade: number | null;
  qualified: boolean;
};
type Stats = {
  trades: number;
  wins: number;
  losses: number;
  profit: number;
  win_rate: number | null;
  last: number | null;
};
type Board = {
  at: number;
  error?: string;
  options: {
    error?: string;
    edges: Record<string, Edge>;
    autopilot: { mode: string; until?: number };
    record: Record<string, Record_>;
    picks: Pick[];
    days: {
      day: string;
      picks: number;
      wins: number;
      open: number;
      pnl: number;
    }[];
    market_open: boolean;
  };
  sports: {
    error?: string;
    parlays: number;
    open: number;
    hit_rate: number | null;
    expected_hit_rate: number | null;
    profit: number;
    roi: number | null;
    credits_left: number | null;
    last_scan: string | null;
    games_scanned: number;
    paper_edges?: Record<
      string,
      { bets: number; open: number; win_rate: number | null; profit: number }
    >;
    recent: {
      id: string;
      day: string;
      status: string;
      payout: number | null;
      hit: number;
      price: number;
      legs: string[];
    }[];
  };
  quotes: {
    error?: string;
    tickers: Record<string, { days: number; snapshots: number }>;
    quotes: number;
    size_mb: number;
  };
  pocket: {
    error?: string;
    all: Stats;
    day: Stats;
    by_source: Record<string, Stats>;
  };
  jobs:
    | {
        name: string;
        state: string;
        last: string;
        next: string;
        result: number;
      }[]
    | { error: string };
};

const money = (v: number | null | undefined) =>
  v == null ? '-' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? '-' : `${(v * 100).toFixed(digits)}%`;
const tone = (v: number | null | undefined) =>
  v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';

function Bar({
  value,
  max,
  mark,
  color,
}: {
  value: number;
  max: number;
  mark?: number;
  color: string;
}) {
  const width = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="dash-bar">
      <i
        style={{
          width: `${width}%`,
          background: color,
          boxShadow: `0 0 10px ${color}`,
        }}
      />
      {mark != null && (
        <b style={{ left: `${Math.min(100, (mark / max) * 100)}%` }} />
      )}
    </div>
  );
}

function Card({
  title,
  icon,
  accent,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="dash-card"
      style={{ '--accent': accent } as React.CSSProperties}
    >
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Problem({ text }: { text?: string }) {
  return text ? (
    <p className="dash-problem">Could not read this: {text}</p>
  ) : null;
}

// The opening page: every scan and paper record at a glance.
export function Dashboard() {
  const [board, setBoard] = useState<Board>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setBoard(await api<Board>(`/dashboard${fresh ? '?fresh=1' : ''}`));
    } catch {
      // Server restarting: the next refresh tries again.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!board)
    return (
      <div className="dashboard">
        <div className="dash-loading">
          <Radar size={28} />
          Gathering scans and records…
        </div>
      </div>
    );

  const o = board.options;
  const s = board.sports;
  const q = board.quotes;
  const p = board.pocket;
  const jobs = Array.isArray(board.jobs) ? board.jobs : [];
  const edges = o.edges ? Object.entries(o.edges) : [];
  const active = edges.reduce(
    (n, [, e]) => n + (e.fading_fear ? 1 : 0) + (e.stretched ? 1 : 0),
    0,
  );
  const closed = (o.picks ?? []).filter((x) => x.how !== 'still open');
  const pickProfit = closed.reduce((sum, x) => sum + (x.pnl ?? 0), 0);
  const recorded = q.tickers
    ? Math.max(0, ...Object.values(q.tickers).map((t) => t.days))
    : 0;
  const sources = p.by_source
    ? Object.entries(p.by_source).filter(
        ([name, v]) => v.trades && name !== 'null',
      )
    : [];

  return (
    <div className="dashboard">
      <header className="dash-head">
        <div>
          <h2>
            <span className="dash-live" /> Command Center
          </h2>
          <p>
            Scans and paper records · updated{' '}
            {new Date(board.at * 1000).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
            {o.market_open != null && (
              <> · market {o.market_open ? 'open' : 'closed'}</>
            )}
          </p>
        </div>
        <button
          className="dash-refresh"
          disabled={loading}
          onClick={() => void load(true)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </header>

      <div className="dash-tiles">
        <div
          className="dash-tile"
          style={{ '--accent': '#39ff14' } as React.CSSProperties}
        >
          <span>Autopilot</span>
          <strong>
            {o.autopilot
              ? o.autopilot.mode === 'off'
                ? 'Shadow'
                : o.autopilot.mode === 'dry_run'
                  ? 'Dry run'
                  : 'LIVE'
              : '-'}
          </strong>
          <small>
            {o.autopilot?.mode === 'off'
              ? 'recording picks, touching nothing'
              : 'until 4pm'}
          </small>
        </div>
        <div
          className="dash-tile"
          style={{ '--accent': '#00e5ff' } as React.CSSProperties}
        >
          <span>Edges active now</span>
          <strong>{active} of 4</strong>
          <small>SPY &amp; QQQ: fading fear, stretched</small>
        </div>
        <div
          className="dash-tile"
          style={{ '--accent': '#ff2bd6' } as React.CSSProperties}
        >
          <span>NBA paper parlays</span>
          <strong className={tone(s.profit)}>
            {s.parlays ? money(s.profit) : `${s.open ?? 0} open`}
          </strong>
          <small>
            {s.parlays
              ? `${s.parlays} settled · ${pct(s.hit_rate)} hit`
              : 'waiting for 3 games a player'}
          </small>
        </div>
        <div
          className="dash-tile"
          style={{ '--accent': '#ffb020' } as React.CSSProperties}
        >
          <span>Pocket Option demo</span>
          <strong className={tone(p.all?.profit)}>
            {money(p.all?.profit)}
          </strong>
          <small>
            {p.all
              ? `${p.all.trades.toLocaleString()} trades · ${pct(p.all.win_rate, 1)} wins`
              : '-'}
          </small>
        </div>
      </div>

      <div className="dash-grid">
        <Card
          title="Options edges today"
          icon={<Gauge size={16} />}
          accent="#39ff14"
        >
          <Problem text={o.error} />
          {edges.map(([ticker, e]) => (
            <div className="dash-edge" key={ticker}>
              <div className="dash-edge-head">
                <strong>{ticker}</strong>
                <span>${e.price?.toFixed(2)}</span>
              </div>
              <Problem text={e.error} />
              {!e.error && (
                <>
                  <div className="dash-meter">
                    <label>
                      Fear vs 20-day average <em>{pct(e.vix_vs_20d, 1)}</em>
                    </label>
                    <Bar
                      value={(e.vix_vs_20d ?? 0) + 0.3}
                      max={0.6}
                      mark={0.3 - 0.0474}
                      color={e.fading_fear ? '#39ff14' : '#5b6b60'}
                    />
                    <span className={`dash-chip ${e.fading_fear ? 'on' : ''}`}>
                      {e.fading_fear
                        ? 'Fading fear: put spreads ON'
                        : 'needs < -4.7%'}
                    </span>
                  </div>
                  <div className="dash-meter">
                    <label>
                      Price vs 20-day average <em>{e.ma20_z?.toFixed(2)} sd</em>
                    </label>
                    <Bar
                      value={(e.ma20_z ?? 0) + 3}
                      max={6}
                      mark={3 + 1.38}
                      color={e.stretched ? '#39ff14' : '#5b6b60'}
                    />
                    <span className={`dash-chip ${e.stretched ? 'on' : ''}`}>
                      {e.stretched
                        ? 'Stretched: call spreads ON'
                        : 'needs ≥ 1.38'}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </Card>

        <Card title="Autopilot picks" icon={<Zap size={16} />} accent="#00e5ff">
          <Problem text={o.error} />
          <div className="dash-pair">
            <div>
              <span>Picks (30 days)</span>
              <strong>{o.picks?.length ?? 0}</strong>
            </div>
            <div>
              <span>Closed result</span>
              <strong className={tone(pickProfit)}>
                {closed.length ? money(pickProfit) : '-'}
              </strong>
            </div>
          </div>
          {o.picks?.length ? (
            <table className="dash-table">
              <tbody>
                {o.picks.slice(0, 6).map((x, k) => (
                  <tr key={k}>
                    <td>{x.day.slice(5)}</td>
                    <td>{x.ticker}</td>
                    <td>{x.kind.replace('edge: ', '')}</td>
                    <td>{x.how}</td>
                    <td className={tone(x.pnl)}>{money(x.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="dash-quiet">
              No picks yet: they appear when an edge turns on.
            </p>
          )}
          <h4>Minimum record for live trading</h4>
          {o.record &&
            Object.entries(o.record).map(([kind, r]) => (
              <div className="dash-meter" key={kind}>
                <label>
                  {kind}{' '}
                  <em>
                    {r.scored}/20 · {pct(r.win_rate)}
                  </em>
                </label>
                <Bar
                  value={r.scored}
                  max={20}
                  color={r.qualified ? '#39ff14' : '#00e5ff'}
                />
              </div>
            ))}
        </Card>

        <Card
          title="DraftKings NBA props"
          icon={<Trophy size={16} />}
          accent="#ff2bd6"
        >
          <Problem text={s.error} />
          <div className="dash-pair">
            <div>
              <span>Hit rate</span>
              <strong>{pct(s.hit_rate)}</strong>
              <small>expected {pct(s.expected_hit_rate)}</small>
            </div>
            <div>
              <span>Paper profit ($10)</span>
              <strong className={tone(s.profit)}>{money(s.profit)}</strong>
              <small>ROI {pct(s.roi, 1)}</small>
            </div>
          </div>
          <div className="dash-meter">
            <label>
              Odds API credits left <em>{s.credits_left ?? '-'} / 500</em>
            </label>
            <Bar value={s.credits_left ?? 0} max={500} color="#ff2bd6" />
          </div>
          <p className="dash-quiet">
            Last scan {s.last_scan ?? '-'} · {s.games_scanned ?? 0} games
            scanned so far
          </p>
          {s.recent?.length ? (
            <ul className="dash-list">
              {s.recent.slice(0, 4).map((r) => (
                <li key={r.id}>
                  <span
                    className={`dash-chip ${r.status === 'won' ? 'on' : r.status === 'lost' ? 'off' : ''}`}
                  >
                    {r.status}
                  </span>
                  {pct(r.hit)} · {r.price.toFixed(2)}x · {r.legs.join(' + ')}
                </li>
              ))}
            </ul>
          ) : (
            <p className="dash-quiet">
              No parlays yet: players need 3 games this season.
            </p>
          )}
          {s.paper_edges && (
            <>
              <h4>Edge leads (paper, early lines)</h4>
              {Object.entries(s.paper_edges).map(([name, e]) => (
                <div className="dash-row" key={name}>
                  <span>{name}</span>
                  <span
                    className={e.profit > 0 ? 'up' : e.profit < 0 ? 'down' : ''}
                  >
                    {e.bets
                      ? `${e.bets} settled · ${pct(e.win_rate)} · ${money(e.profit)}`
                      : 'none settled'}{' '}
                    · {e.open} open
                  </span>
                </div>
              ))}
            </>
          )}
        </Card>

        <Card
          title="Real option quotes & scalp sim"
          icon={<CandlestickChart size={16} />}
          accent="#ffb020"
        >
          <Problem text={q.error} />
          <div className="dash-pair">
            <div>
              <span>Quotes recorded</span>
              <strong>{q.quotes?.toLocaleString() ?? '-'}</strong>
              <small>{q.size_mb ?? 0} MB</small>
            </div>
            <div>
              <span>Days recorded</span>
              <strong>{recorded}</strong>
              <small>scalp sim judges at 5+</small>
            </div>
          </div>
          <Bar value={recorded} max={5} color="#ffb020" />
          {q.tickers &&
            Object.entries(q.tickers).map(([t, v]) => (
              <div className="dash-row" key={t}>
                <span>{t}</span>
                <span>
                  {v.snapshots} snapshots · {v.days} day
                  {v.days === 1 ? '' : 's'}
                </span>
              </div>
            ))}
        </Card>

        <Card
          title="Pocket Option demo Trader"
          icon={<Activity size={16} />}
          accent="#39ff14"
        >
          <Problem text={p.error} />
          <div className="dash-pair">
            <div>
              <span>All time</span>
              <strong className={tone(p.all?.profit)}>
                {money(p.all?.profit)}
              </strong>
              <small>
                {p.all?.wins}W / {p.all?.losses}L
              </small>
            </div>
            <div>
              <span>Last 24 hours</span>
              <strong className={tone(p.day?.profit)}>
                {p.day?.trades ? money(p.day.profit) : '-'}
              </strong>
              <small>
                {p.day?.trades ? `${p.day.trades} trades` : 'not trading'}
              </small>
            </div>
          </div>
          <div className="dash-meter">
            <label>
              Win rate vs break-even <em>{pct(p.all?.win_rate, 1)} / ~52%</em>
            </label>
            <Bar
              value={p.all?.win_rate ?? 0}
              max={1}
              mark={0.52}
              color={(p.all?.win_rate ?? 0) >= 0.52 ? '#39ff14' : '#ff4d5e'}
            />
          </div>
          {sources.map(([name, v]) => (
            <div className="dash-row" key={name}>
              <span>{name}</span>
              <span className={tone(v.profit)}>
                {v.trades} · {pct(v.win_rate, 1)} · {money(v.profit)}
              </span>
            </div>
          ))}
        </Card>

        <Card
          title="Scheduled jobs"
          icon={<CalendarClock size={16} />}
          accent="#00e5ff"
        >
          <Problem
            text={Array.isArray(board.jobs) ? undefined : board.jobs.error}
          />
          <ul className="dash-jobs">
            {jobs.map((j) => (
              <li key={j.name}>
                <i className={j.result === 0 ? 'ok' : 'bad'} />
                <strong>{j.name.replace('OpenDots ', '')}</strong>
                <span>
                  last {j.last.slice(5)} · next {j.next.slice(5)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
