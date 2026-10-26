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
  profit: number | null; // null when no trade recorded a profit
  win_rate: number | null;
  last: number | null;
};
type WeeklyPut = {
  day: string;
  expiry: string;
  short: number;
  long: number;
  credit: number;
  result: string;
  closed_day: string | null;
  pnl: number | null;
};
type WeeklyPuts = {
  trades: number;
  wins: number;
  win_rate: number | null;
  profit: number;
  open: WeeklyPut | null;
  recent: WeeklyPut[];
  rule: string;
  lab: string;
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
    weekly_puts?: WeeklyPuts;
    by_kind?: Record<string, { taken?: number }>;
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
    real_bets_placed?: number;
    paper_edges?: Record<
      string,
      {
        bets: number;
        open: number;
        win_rate: number | null;
        profit: number;
        line_moved_our_way?: number;
      }
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

// What decides each test. The cards below show the numbers; these turn them into a verdict
// with the bar it has to clear, so "is this working?" has one answer per line.
const RULES = {
  pocketBreakEven: 0.52, // At Pocket Option's ~92% payout a trade must win 52% to break even.
  pocketEnough: 300, // Demo trades before a verdict on a rule.
  optionsEnough: 100, // Scored picks before trusting a setup (target: 80% wins with profit).
  optionsWinGoal: 0.8,
  weeklyEnough: 20, // Closed weekly put spreads before comparing with the lab's 87%.
  betsEnough: 50, // Settled bets before judging a sports lead.
  lineBreakEven: 0.524, // Winning share needed at -110 odds.
};

type Verdict = {
  name: string;
  status: 'stop' | 'early' | 'waiting' | 'good';
  label: string;
  evidence: string;
  decides: string;
  next: string;
};

function verdicts(board: Board): Verdict[] {
  const out: Verdict[] = [];
  const p = board.pocket?.all;
  if (p?.trades) {
    const enough = p.trades >= RULES.pocketEnough;
    const passing =
      (p.win_rate ?? 0) >= RULES.pocketBreakEven && (p.profit ?? 0) > 0;
    out.push({
      name: 'Pocket Option (demo)',
      status: !enough ? 'early' : passing ? 'good' : 'stop',
      label: !enough ? 'Too early' : passing ? 'Passing' : 'Losing',
      evidence: `${p.trades.toLocaleString()} trades, ${pct(p.win_rate, 1)} wins, ${money(p.profit)}${
        board.pocket.day?.trades ? '' : ' · not trading now'
      }`,
      decides: `${pct(RULES.pocketBreakEven)}+ wins and a profit over ${RULES.pocketEnough}+ demo trades`,
      next: passing
        ? 'Keep testing on demo; real money only after you decide'
        : 'No edge: keep it off real money. A new rule gets its own 300-trade demo test.',
    });
  }
  const record = board.options?.record ?? {};
  const scored = Object.values(record).reduce((n, r) => n + (r.scored ?? 0), 0);
  const detail = Object.entries(record)
    .map(([k, r]) =>
      r.scored ? `${k} ${pct(r.win_rate)} of ${r.scored}` : `${k} none yet`,
    )
    .join(' · ');
  out.push({
    name: 'Options autopilot (shadow)',
    status:
      scored === 0
        ? 'waiting'
        : scored < RULES.optionsEnough
          ? 'early'
          : 'good',
    label:
      scored < RULES.optionsEnough
        ? `${scored ? 'Too early' : 'Waiting'}: ${scored} of ${RULES.optionsEnough}`
        : 'Enough data',
    evidence: detail || 'No picks scored yet',
    decides: `${RULES.optionsEnough} scored picks at ${pct(RULES.optionsWinGoal)}+ wins with a profit`,
    next: 'Robinhood funding waits for this record; picks only come when an edge is active',
  });
  const w = board.options?.weekly_puts;
  if (w) {
    out.push({
      name: 'Weekly put spread (paper)',
      status:
        w.trades === 0
          ? 'waiting'
          : w.trades < RULES.weeklyEnough
            ? 'early'
            : 'good',
      label:
        w.trades === 0
          ? 'Waiting for first result'
          : `Too early: ${w.trades} of ${RULES.weeklyEnough}`,
      evidence: w.open
        ? `Open ${w.open.short}/${w.open.long} put, credit $${w.open.credit.toFixed(2)}, expires ${w.open.expiry}` +
          (w.trades ? ` · ${w.wins}/${w.trades} won, ${money(w.profit)}` : '')
        : `${w.wins}/${w.trades} won, ${money(w.profit)}`,
      decides: `${RULES.weeklyEnough} closed trades near the lab's 87% wins`,
      next: w.open
        ? `First result at expiry, ${w.open.expiry}`
        : 'Next one opens when SPY is above its 200-day average again',
    });
  }
  const s = board.sports;
  if (s) {
    const hit = s.hit_rate ?? 0;
    out.push({
      name: 'NBA prop parlays (paper)',
      status:
        s.parlays === 0
          ? 'waiting'
          : s.parlays < RULES.betsEnough
            ? 'early'
            : hit >= (s.expected_hit_rate ?? 1)
              ? 'good'
              : 'stop',
      label:
        s.parlays < RULES.betsEnough
          ? `Too early: ${s.parlays} of ${RULES.betsEnough}`
          : 'Enough data',
      evidence: `${s.parlays} settled, ${pct(s.hit_rate)} hit vs ${pct(s.expected_hit_rate)} expected, ${money(s.profit)}`,
      decides: `${RULES.betsEnough} settled parlays hitting at least the model's expected rate`,
      next: 'Picks daily at 5:30 pm, settled at 9 am',
    });
    for (const [name, e] of Object.entries(s.paper_edges ?? {})) {
      const enough = e.bets >= RULES.betsEnough;
      const passing = (e.win_rate ?? 0) >= RULES.lineBreakEven && e.profit > 0;
      out.push({
        name: `${name} lead (paper)`,
        status:
          e.bets === 0
            ? 'waiting'
            : !enough
              ? 'early'
              : passing
                ? 'good'
                : 'stop',
        label:
          e.bets === 0
            ? `Waiting: ${e.open} open`
            : !enough
              ? `Too early: ${e.bets} of ${RULES.betsEnough}`
              : passing
                ? 'Passing'
                : 'Losing',
        evidence:
          e.bets === 0
            ? `${e.open} bets open, none settled`
            : `${e.bets} settled, ${pct(e.win_rate)} wins, ${money(e.profit)}${
                e.line_moved_our_way != null
                  ? ` · line moved our way ${pct(e.line_moved_our_way)}`
                  : ''
              }`,
        decides: `${pct(RULES.lineBreakEven, 1)}+ wins over ${RULES.betsEnough} settled bets`,
        next:
          e.bets && (e.win_rate ?? 0) < RULES.lineBreakEven
            ? 'Under break-even so far; keep it on paper'
            : 'Keep collecting',
      });
    }
  }
  return out;
}

function realMoney(board: Board) {
  const taken = Object.values(board.options?.by_kind ?? {}).reduce(
    (n, k) => n + (k.taken ?? 0),
    0,
  );
  const bets = board.sports?.real_bets_placed ?? 0;
  return taken + bets === 0
    ? 'No real money in play: every test below is paper or demo.'
    : `Real money: ${taken} option trades taken, ${bets} real bets placed.`;
}

function Verdicts({ board }: { board: Board }) {
  const rows = verdicts(board);
  return (
    <section className="dash-verdicts">
      <h3>Where each test stands</h3>
      <p className="dash-quiet">{realMoney(board)}</p>
      <table>
        <thead>
          <tr>
            <th>Test</th>
            <th>Verdict</th>
            <th>So far</th>
            <th>What decides it</th>
            <th>Next</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>
                <span className={`dash-verdict ${r.status}`}>{r.label}</span>
              </td>
              <td>{r.evidence}</td>
              <td>{r.decides}</td>
              <td>{r.next}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

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
  wide = false,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={wide ? 'dash-card wide' : 'dash-card'}
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
  // The journal tags trades with where they were placed; trades from before tagging
  // began have no source. Showing only "site" (1,491 of 2,105) looked like missing trades.
  const sourceLabel: Record<string, string> = {
    site: 'Placed on the site',
    null: 'Before tagging (Oct 18-19, profit not recorded)',
  };
  const sources = p.by_source
    ? Object.entries(p.by_source)
        .filter(([, v]) => v.trades)
        .map(([name, v]) => [sourceLabel[name] ?? name, v] as const)
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

      <Verdicts board={board} />

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

        {o.weekly_puts && (
          <Card
            title="Weekly put spread (paper)"
            icon={<Zap size={16} />}
            accent="#39ff14"
          >
            <div className="dash-pair">
              <div>
                <span>Closed</span>
                <strong>
                  {o.weekly_puts.wins}/{o.weekly_puts.trades}
                </strong>
                <small>{pct(o.weekly_puts.win_rate)}</small>
              </div>
              <div>
                <span>Paper result</span>
                <strong className={tone(o.weekly_puts.profit)}>
                  {o.weekly_puts.trades ? money(o.weekly_puts.profit) : '-'}
                </strong>
              </div>
            </div>
            {o.weekly_puts.open ? (
              <p className="dash-quiet">
                Open: {o.weekly_puts.open.short}/{o.weekly_puts.open.long} put,
                expires {o.weekly_puts.open.expiry.slice(5)}, credit $
                {o.weekly_puts.open.credit.toFixed(2)}
              </p>
            ) : (
              <p className="dash-quiet">
                Nothing open: the next starts at a close above the 200-day
                average.
              </p>
            )}
            {o.weekly_puts.recent.length > 0 && (
              <table className="dash-table">
                <tbody>
                  {o.weekly_puts.recent.map((x, k) => (
                    <tr key={k}>
                      <td>{x.day.slice(5)}</td>
                      <td>
                        {x.short}/{x.long}
                      </td>
                      <td>{x.result}</td>
                      <td className={tone(x.pnl)}>{money(x.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="dash-quiet">
              {o.weekly_puts.rule}. Lab: {o.weekly_puts.lab}.
            </p>
          </Card>
        )}

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
              <small>
                expected {pct(s.expected_hit_rate)} · {s.parlays ?? 0} settled
                {(s.parlays ?? 0) < 20 ? ', too few to judge' : ''}
              </small>
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
          wide
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
