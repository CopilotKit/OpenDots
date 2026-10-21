"""Strategy lab: tests thousands of credit-spread rule sets on SPY and QQQ over
the last ~60 trading days, to find the ones that win often and still make money.

Each rule set says when to sell a $1-wide credit spread (which side, how far out
of the money, how many days to expiry, what time, which market filter) and how
to manage it (profit target, stop, trailing stop; always out by 3:45pm on
expiry day). Every trade is replayed on 5-minute prices.

Option prices are modeled, not recorded (free history of option quotes does not
exist): Black-Scholes at the volatility index of that 5-minute bar (VIX for SPY,
VXN for QQQ), scaled to each expiry's at-the-money level and bent by today's
real skew (out-of-the-money options cost more: the seller's edge), both fitted
from today's Cboe chain. Costs: $0.02 a side off the mid (limit orders) and
$0.03 a contract a side.

Honest testing: rule sets are chosen on the first two thirds of the days and
judged on the last third (about four weeks), which the choice never saw.

Run: python strategy_lab.py   (writes "Strategy Lab.md" to the vault)
"""
from __future__ import annotations

import json
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta
from itertools import product
from pathlib import Path

import numpy as np

import edge_lab
import options_guide as og

VOL_INDEX = {'SPY': '^VIX', 'QQQ': '^VXN'}
SLIP = 0.02          # Per spread, per side, off the mid.
FEE = 0.03           # Per contract, per side.
WIDTH = 1.0          # $1 wide: max loss under the $100 rule.
REPORT = edge_lab.REPORT.with_name('Strategy Lab.md')
RESULTS = Path(__file__).parent.parent / 'data' / 'strategy-lab.json'

# The rule sets: entries x exits.
TIMES = ((9, 45), (10, 30), (12, 0), (14, 0))
DTES = (0, 1, 2, 5)              # Trading days to expiry.
DELTAS = (0.05, 0.10, 0.15, 0.20)
SIDES = ('put', 'call', 'both', 'trend', 'fade')
FILTERS = ('none', 'premium', 'calm')
MIN_CREDITS = (0.05, 0.10)
TARGETS = (0.25, 0.35, 0.45, 0.5, 0.75, None)  # Share of the credit kept; None: hold.
STOPS = (1.5, 2.0, 3.0, None)                   # Cost to close as a multiple of the credit.
TRAILS = (False, True)
TICKER_SETS = (('SPY',), ('QQQ',), ('SPY', 'QQQ'))
MIN_TRAIN_TRADES = 12


# Pricing (vectorized) -------------------------------------------------------
def ncdf(x):
    """Standard normal CDF on arrays (Abramowitz-Stegun 7.1.26, error under 1e-7)."""
    x = np.asarray(x, dtype=float)
    t = 1 / (1 + 0.3275911 * np.abs(x) / math.sqrt(2))
    poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    erf = 1 - poly * np.exp(-(x * x) / 2)
    return 0.5 * (1 + np.sign(x) * erf)


def bs(spot, strike, years, vol, call: bool):
    spot, years, vol = (np.asarray(a, dtype=float) for a in (spot, years, vol))
    intrinsic = np.maximum(spot - strike, 0) if call else np.maximum(strike - spot, 0)
    live = (years > 0) & (vol > 0)
    root = np.where(live, vol * np.sqrt(np.maximum(years, 1e-12)), 1.0)
    d1 = (np.log(spot / strike) + 0.5 * root * root) / root
    d2 = d1 - root
    value = spot * ncdf(d1) - strike * ncdf(d2) if call else strike * ncdf(-d2) - spot * ncdf(-d1)
    return np.where(live, value, intrinsic)


# Today's chain: at-the-money level per expiry and the skew --------------------
def dte_bucket(days: int) -> int:
    return 0 if days <= 0 else 1 if days == 1 else 2 if days <= 3 else 3


def fit_surface(ticker: str, index_now: float, getter=og.fetch) -> dict:
    """{'level': {bucket: atm iv / index}, 'put'/'call': (z grid, iv / atm iv)} from today's chain.
    z = ln(strike / price) / (atm iv * sqrt(years)): how many expected moves out."""
    chain = og.parse_chain(getter(f'options/{ticker}.json'))
    spot, asof = chain['price'], chain['asof']
    by_expiry = defaultdict(list)
    for o in chain['options']:
        by_expiry[o['expiry']].append(o)
    levels, points = defaultdict(list), {'put': defaultdict(list), 'call': defaultdict(list)}
    trading_days = lambda e: int(np.busday_count(asof.date(), e))
    for expiry, options in sorted(by_expiry.items()):
        days = trading_days(expiry)
        if not 1 <= days <= 15:
            continue  # After the close, today's expiring options show junk volatility.
        near = sorted(options, key=lambda o: abs(o['strike'] - spot))[:4]
        atm = float(np.median([o['iv'] for o in near if 0.03 < o['iv'] < 3] or [0]))
        if not atm:
            continue
        levels[dte_bucket(days)].append(atm / (index_now / 100))  # The index is in points: 17.3 = 17.3%.
        years = og.years_to(expiry, asof)
        for o in options:
            side = 'call' if o['call'] else 'put'
            if o['bid'] <= 0 or not 0.03 < o['iv'] < 3 or (o['strike'] < spot) == o['call']:
                continue  # Out-of-the-money options with a bid only.
            z = math.log(o['strike'] / spot) / (atm * math.sqrt(years))
            if -5 <= z <= 5:
                points[side][round(z * 4) / 4].append(o['iv'] / atm)
    level = {b: float(np.median(v)) for b, v in levels.items()}
    for b in range(4):  # Same-day options are fitted from 1-day ones (after the close today's are junk).
        level.setdefault(b, level.get(b + 1) or level.get(b - 1) or 1.0)
    surface = {'level': level, 'spot': spot, 'asof': asof.strftime('%Y-%m-%d %H:%M')}
    for side in ('put', 'call'):
        zs = sorted(points[side])
        surface[side] = (np.array(zs or [0.0]), np.array([float(np.median(points[side][z])) for z in zs] or [1.0]))
    return surface


def leg_vol(surface: dict, index, days_left: int, spot, strike, years, side: str):
    """The volatility a leg is priced at: index -> this expiry's at-the-money level -> the skew."""
    atm = np.asarray(index, dtype=float) / 100 * surface['level'][dte_bucket(days_left)]
    z = np.log(strike / np.asarray(spot)) / (atm * np.sqrt(np.maximum(years, 1e-9)))
    zs, ratios = surface[side]
    return atm * np.interp(z, zs, ratios)


# History ------------------------------------------------------------------
def load(documents: dict | None = None) -> dict:
    """Per ticker: the sessions' 5-minute bars with the volatility index that bar."""
    documents = documents or {s: edge_lab.download(s) for s in (*VOL_INDEX, *VOL_INDEX.values())}
    out = {}
    for ticker, index_symbol in VOL_INDEX.items():
        index = {b['t']: b['c'] for bars in edge_lab.sessions(documents[index_symbol]).values() for b in bars}
        days = {}
        for day, bars in edge_lab.sessions(documents[ticker]).items():
            last = None
            rows = []
            for b in bars:
                last = index.get(b['t'], last)
                if last:
                    rows.append({**b, 'index': last})
            if len(rows) >= 70:  # Full sessions only.
                days[day] = rows
        out[ticker] = days
    return out


# One trade ------------------------------------------------------------------
def trade(days: dict, names: list, d: int, at: tuple, dte: int, delta: float, side: str, surface: dict) -> dict | None:
    """Sell a $1 credit spread on day d at `at`, expiring `dte` trading days later,
    short leg nearest `delta`. Returns the credit and the path of the cost to close."""
    if d + dte >= len(names):
        return None
    today = days[names[d]]
    i = next((k for k, b in enumerate(today) if (b['t'].hour, b['t'].minute) == at), None)
    if i is None:
        return None
    expiry_day = names[d + dte]
    expiry = datetime.strptime(expiry_day, '%Y-%m-%d').replace(hour=16)
    path = today[i:] + [b for n in names[d + 1:d + dte + 1] for b in days[n]]
    spot = np.array([b['c'] for b in path])
    t = [b['t'] for b in path]
    years = np.array([max((expiry - x).total_seconds(), 0) / (365 * 24 * 3600) for x in t])
    position = {n: k for k, n in enumerate(names[d:d + dte + 1], d)}
    days_left = np.array([(d + dte) - position[x.strftime('%Y-%m-%d')] for x in t])
    index = np.array([b['index'] for b in path])
    atm_path = index / 100 * np.array([surface['level'][dte_bucket(int(x))] for x in days_left])
    call = side == 'call'
    # Pick the short strike: the whole-dollar strike whose delta is nearest the target.
    s0, y0 = spot[0], max(years[0], 1 / (365 * 24 * 12))
    strikes = np.arange(math.floor(s0 * 0.85), math.ceil(s0 * 1.15) + 1, 1.0)
    strikes = strikes[strikes > s0] if call else strikes[strikes < s0]
    vols = leg_vol(surface, index[0], dte, s0, strikes, y0, side)
    d1 = (np.log(s0 / strikes) + 0.5 * vols ** 2 * y0) / (vols * math.sqrt(y0))
    deltas = ncdf(d1) if call else ncdf(d1) - 1
    short = float(strikes[np.argmin(np.abs(np.abs(deltas) - delta))])
    long = short + WIDTH if call else short - WIDTH

    zs, ratios = surface[side]

    def value(k):  # The leg's value at every bar: index -> expiry level -> skew, all at once.
        z = np.log(k / spot) / (atm_path * np.sqrt(np.maximum(years, 1e-9)))
        return bs(spot, k, years, atm_path * np.interp(z, zs, ratios), call)

    mid = value(short) - value(long)
    credit = float(mid[0]) - SLIP
    if credit < 0.03:
        return None
    cost = mid + SLIP
    cost[-1] = mid[-1]  # Expiring: settles at its intrinsic value, no spread to cross.
    minute = np.array([x.hour * 60 + x.minute for x in t])
    on_expiry = np.array([x.strftime('%Y-%m-%d') == expiry_day for x in t])
    return {'credit': credit, 'cost': cost, 'mid': mid, 'out': int(np.argmax(on_expiry & (minute >= 15 * 60 + 45))) or len(cost) - 1,
            'short': short, 'spot': float(s0), 'day': names[d]}


def exit_pnl(tr: dict, target, stop, trail: bool) -> float:
    """Dollars made on one contract, managed by the rules; out by 3:45pm on expiry day.
    Targets and stops watch the mid (as the listener's model does); the exit pays the costs."""
    credit, cost = tr['credit'], tr['cost'][1:tr['out'] + 1]
    entry, mid = tr['mid'][0], tr['mid'][1:tr['out'] + 1]
    pnl = (credit - cost) * 100 - 4 * FEE
    end = len(cost) - 1
    hits = [end]
    if target is not None:
        hit = np.flatnonzero(entry - mid >= target * entry)
        if hit.size:
            hits.append(int(hit[0]))
    if stop is not None:
        hit = np.flatnonzero(mid >= stop * entry)
        if hit.size:
            hits.append(int(hit[0]))
    if trail:  # As the exit listener runs it: armed at $2 (or 10%), floor at half the best.
        marked = (entry - mid) * 100 - 4 * FEE
        peak = np.maximum.accumulate(marked)
        armed = peak >= max(2.0, 0.1 * entry * 100)
        hit = np.flatnonzero(armed & (marked <= np.maximum(1.0, 0.5 * peak)))
        if hit.size:
            hits.append(int(hit[0]))
    return float(pnl[min(hits)]) if len(pnl) else 0.0


# Entry filters --------------------------------------------------------------
def features(rows: list, i: int, closes: list, surface: dict) -> dict:
    """At the entry bar: direction vs the open and VWAP, implied vs realized vol, range so far."""
    bars = rows[:i + 1]
    volume = sum(b['v'] for b in bars) or 1
    vwap = sum((b['h'] + b['l'] + b['c']) / 3 * b['v'] for b in bars) / volume
    price = bars[-1]['c']
    up = price > vwap and price > bars[0]['o']
    down = price < vwap and price < bars[0]['o']
    returns = np.diff(np.log(closes[-21:])) if len(closes) >= 11 else np.array([])
    realized = float(returns.std(ddof=1) * math.sqrt(252)) if returns.size > 2 else None
    implied = bars[-1]['index'] / 100 * surface['level'][1]
    daily_move = implied / math.sqrt(252) * price
    return {'trend': 'up' if up else 'down' if down else 'flat',
            'premium': bool(realized and implied > 1.2 * realized),
            'calm': (max(b['h'] for b in bars) - min(b['l'] for b in bars)) < 0.5 * daily_move}


def sides_for(rule: str, trend: str) -> tuple:
    if rule in ('put', 'call'):
        return (rule,)
    if rule == 'both':
        return ('put', 'call')
    if trend == 'flat':
        return ()
    up = trend == 'up'
    return (('put',) if up else ('call',)) if rule == 'trend' else (('call',) if up else ('put',))


def stats(pnls: list[float]) -> dict:
    if not pnls:
        return {'n': 0}
    pnls = [float(p) for p in pnls]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    return {'n': len(pnls), 'win_rate': round(len(wins) / len(pnls), 3), 'per_trade': round(sum(pnls) / len(pnls), 2),
            'avg_win': round(sum(wins) / len(wins), 2) if wins else 0.0,
            'avg_loss': round(sum(losses) / len(losses), 2) if losses else 0.0,
            'worst': round(min(pnls), 2), 'total': round(sum(pnls), 2)}


# The lab ------------------------------------------------------------------
def run(history: dict | None = None, surfaces: dict | None = None, log=print) -> dict:
    started = time.time()
    history = history or load()
    if surfaces is None:
        now_index = {t: [r['index'] for r in rows][-1] for t, days in history.items() for rows in [list(days.values())[-1]]}
        surfaces = {t: fit_surface(t, now_index[t]) for t in history}
    exits = list(product(TARGETS, STOPS, TRAILS))
    # Every distinct trade once: (ticker, day, time, dte, delta, side) -> exit -> pnl, plus credit and filters.
    trades: dict = {}
    for ticker, days in history.items():
        names = sorted(days)
        closes: list[float] = []
        for d, name in enumerate(names):
            rows = days[name]
            for at in TIMES:
                i = next((k for k, b in enumerate(rows) if (b['t'].hour, b['t'].minute) == at), None)
                if i is None or len(closes) < 10:
                    continue
                f = features(rows, i, closes, surfaces[ticker])
                for dte, delta, side in product(DTES, DELTAS, ('put', 'call')):
                    tr = trade(days, names, d, at, dte, delta, side, surfaces[ticker])
                    if tr:
                        trades[(ticker, name, at, dte, delta, side)] = {
                            'credit': tr['credit'], 'features': f,
                            'pnl': np.array([exit_pnl(tr, *e) for e in exits])}
            closes.append(rows[-1]['c'])
        log(f'{ticker}: {sum(1 for k in trades if k[0] == ticker)} trades replayed ({time.time() - started:.0f}s)')
    all_days = sorted({k[1] for k in trades})
    split = all_days[int(len(all_days) * 2 / 3)] if all_days else ''
    # Every rule set: gather its trades' pnl vectors (all exits at once), split train/test.
    results = []
    for tickers, rule, dte, delta, at, filt, floor in product(TICKER_SETS, SIDES, DTES, DELTAS, TIMES, FILTERS, MIN_CREDITS):
        train, test = [], []
        for ticker in tickers:
            for name in all_days:
                key = (ticker, name, at, dte, delta)
                f = next((trades[key + (s,)]['features'] for s in ('put', 'call') if key + (s,) in trades), None)
                if f is None or (filt != 'none' and not f[filt]):
                    continue
                for s in sides_for(rule, f['trend']):
                    tr = trades.get(key + (s,))
                    if tr and tr['credit'] >= floor:
                        (train if name < split else test).append(tr['pnl'])
        if len(train) < MIN_TRAIN_TRADES or not test:
            continue
        train_m, test_m = np.array(train), np.array(test)
        for e, (target, stop, trail) in enumerate(exits):
            tr_p = train_m[:, e]
            win = float((tr_p > 0).mean())
            if win < og.MIN_POP or tr_p.mean() <= 0:
                continue  # Chosen on the training days only: 80% wins and a profit.
            results.append({
                'tickers': '+'.join(tickers), 'side': rule, 'dte': dte, 'delta': delta, 'time': f'{at[0]}:{at[1]:02d}',
                'filter': filt, 'min_credit': floor, 'target': target, 'stop': stop, 'trail': trail,
                'train': stats(list(tr_p)), 'test': stats(list(test_m[:, e]))})
    tested = len(list(product(TICKER_SETS, SIDES, DTES, DELTAS, TIMES, FILTERS, MIN_CREDITS))) * len(exits)
    held = [r for r in results if r['test'].get('win_rate', 0) >= og.MIN_POP and r['test'].get('per_trade', 0) > 0]
    # Ranked by the weaker of the two periods: a lucky few weeks alone does not top the list.
    robust = lambda r: min(r['train']['per_trade'], r['test']['per_trade']) * min(r['train']['n'] + r['test']['n'], 60)
    results.sort(key=lambda r: (r['train']['per_trade'] * min(r['train']['n'], 40)), reverse=True)
    spy = history.get('SPY', {})
    test_days = [d for d in sorted(spy) if d >= split]
    market = None
    if test_days:
        closes = [spy[d][-1]['c'] for d in test_days]
        changes = [closes[k] / closes[k - 1] - 1 for k in range(1, len(closes))]
        market = {'from': round(spy[test_days[0]][0]['o'], 2), 'to': round(closes[-1], 2),
                  'change': round(closes[-1] / spy[test_days[0]][0]['o'] - 1, 4),
                  'worst_day': round(min(changes), 4) if changes else 0.0}
    return {'days': len(all_days), 'first': all_days[0] if all_days else None, 'last': all_days[-1] if all_days else None,
            'split': split, 'rule_sets': tested, 'passed_train': len(results), 'held_on_test': len(held),
            'top': dedupe(results)[:40], 'held': dedupe(sorted(held, key=robust, reverse=True))[:25], 'test_market': market,
            'surfaces': {t: {'level': s['level'], 'asof': s.get('asof', '')} for t, s in surfaces.items()},
            'seconds': round(time.time() - started)}


def dedupe(rows: list[dict]) -> list[dict]:
    """Rule sets with the same trades and results (e.g. two credit floors that never differed) shown once."""
    seen, out = set(), []
    for r in rows:
        key = (r['tickers'], r['side'], r['dte'], r['delta'], r['time'], r['filter'], r['target'], r['stop'], r['trail'],
               json.dumps(r['train']), json.dumps(r['test']))
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def describe(r: dict) -> str:
    side = {'put': 'put spreads', 'call': 'call spreads', 'both': 'put and call spreads',
            'trend': 'with the trend', 'fade': 'against the trend'}[r['side']]
    exit_ = (f'keep {r["target"]:.0%}' if r['target'] else 'hold') + (f', stop {r["stop"]:g}x' if r['stop'] else ', no stop') \
        + (', trailing' if r['trail'] else '')
    when = f'{r["dte"]}-day' if r['dte'] else 'same-day'
    filt = {'none': '', 'premium': ', only when implied vol is rich', 'calm': ', only on calm mornings'}[r['filter']]
    return f'{r["tickers"]} {when} {side}, {r["delta"]:.2f} delta at {r["time"]}{filt}, credit ${r["min_credit"]:.2f}+; {exit_}'


def report(lab: dict) -> str:
    def row(r):
        a, b = r['train'], r['test']
        return (f'| {describe(r)} | {a["n"]} / {a["win_rate"]:.0%} / ${a["per_trade"]:+.2f} | '
                f'{b["n"]} / {b.get("win_rate", 0):.0%} / ${b.get("per_trade", 0):+.2f} / worst ${b.get("worst", 0):+.0f} |')
    head = '| Rule set | Train: trades / wins / $ a trade | Test (unseen): trades / wins / $ a trade / worst |\n|---|---|---|'
    share = lab['held_on_test'] / lab['passed_train'] if lab['passed_train'] else 0
    lines = ['---', 'tags:', '  - "trading"', '  - "strategy-lab"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Strategy Lab', '',
             f'{lab["rule_sets"]:,} credit-spread rule sets replayed on {lab["days"]} trading days '
             f'({lab["first"]} to {lab["last"]}). Chosen on the days before {lab["split"]}; judged on the days from '
             f'{lab["split"]} (about four weeks), which the choice never saw. Modeled option prices '
             f'(volatility index + today\'s skew), $0.02 a side off the mid, $0.03 a contract a side.', '',
             f'**{lab["passed_train"]:,} rule sets** met the target on the training days (80% wins with a profit). '
             f'**{lab["held_on_test"]:,} ({share:.0%})** still did on the unseen days. The lower that share, the more '
             'of the training result was luck.', '',
             *([f'The unseen weeks\' market: SPY from ${lab["test_market"]["from"]} to ${lab["test_market"]["to"]} '
                f'({lab["test_market"]["change"]:+.1%}), worst day {lab["test_market"]["worst_day"]:+.1%}. Rule sets '
                'that only won in this kind of market are not proven for another.', ''] if lab.get('test_market') else []),
             '## Held up on the unseen days', '',
             'Ranked by the weaker of the two periods, so neither a lucky stretch alone nor a large sample alone tops it.', '',
             head, *[row(r) for r in lab['held'][:20]], '',
             '## Best on the training days (and how they then did)', '', head, *[row(r) for r in lab['top'][:20]], '',
             '## Read with care', '',
             '- Option prices are a model, not recorded quotes. Real skew changes day to day, and same-day options '
             'move faster near the close than the model shows.',
             '- One contract a trade; the owner\'s limits (one trade at a time, $60 a day) are not applied here.',
             '- A rule set that held up is a candidate for the dry-run autopilot, not proof. Its live record decides.',
             f'- Data: Yahoo 5-minute prices; VIX for SPY, VXN for QQQ; skew from Cboe ({", ".join(f"{t} {s["asof"]}" for t, s in lab["surfaces"].items())}).',
             '', f'Run again: `python localtools/strategy_lab.py` ({lab["seconds"]}s).']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    lab = run()
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps(lab, indent=1, default=str))
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(report(lab), encoding='utf-8')
    print(json.dumps({k: lab[k] for k in ('days', 'split', 'rule_sets', 'passed_train', 'held_on_test', 'seconds')}))
    for r in lab['held'][:10]:
        print(describe(r), r['train'], r['test'])
