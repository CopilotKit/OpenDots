"""Spread hold lab: the best expiry, hold and "close by" deadline for SPY credit spreads.

Every trading day since 1993 at the close, sell a put (or call) credit spread that
expires D calendar days later, short leg at a chosen delta, and manage it by:
  - target:   buy it back once it has lost that share of its value (25/50/75%);
  - stop:     buy it back once it costs 2x or 3x the credit;
  - deadline: buy it back when L calendar days are left, whatever it's worth.
The strategy lab only tested 0-5 day spreads; this one tests 7-60 days.

Option prices are modeled (free history of option quotes does not exist):
Black's formula on the forward (that day's T-bill rate, 1.3% dividends) at that day's VIX, scaled to the expiry's at-the-money level and bent
by the skew (out-of-the-money puts cost more), both fitted from a saved Cboe chain.
Each trade is scaled to the latest SPY close so strikes, widths and costs are in
today's dollars. Costs: $0.02 a side off the mid and $0.03 a contract a side.

Known optimism: the term structure and skew are today's. In a crash, short-dated
volatility jumps above the VIX, so short spreads would cost more to stop out than
modeled here.

Honest testing: rules are chosen on 1993-2009 and judged on 2010-2026.

Run: python spread_hold_lab.py   (writes "Spread Hold Lab.md" to the vault)
"""
from __future__ import annotations

import gzip
import json
import math
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from itertools import product
from pathlib import Path

import numpy as np

import options_guide as og
from strategy_lab import bs, ncdf

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'futures'
CHAIN = ROOT / 'data' / 'option-history' / 'cboe' / 'SPY' / '2026-10-22.json.gz'
RESULTS = ROOT / 'data' / 'spread-hold-lab.json'
REPORT = Path('C:/Users/inter/Desktop/MainAINotes/Site Maps/Robinhood/Spread Hold Lab.md')
SLIP = 0.02
FEE = 0.03
SPLIT = date(2010, 1, 1)
SKEW_BUCKETS = (10, 30, 90)               # Calendar days: the skew is fitted for each group of expiries.
DIVIDEND = 0.013                          # SPY's yield, about 1.1-2% over the years.

DTES = (7, 14, 21, 30, 45, 60)            # Calendar days to expiry.
DELTAS = (0.10, 0.16, 0.20, 0.30)
SIDES = ('put', 'call')
WIDTHS = (1.0, 5.0, 10.0)                 # Dollars, at today's SPY price.
TARGETS = (0.25, 0.5, 0.75, None)         # Share of the credit kept; None: no target.
STOPS = (2.0, 3.0, None)                  # Cost to close as a multiple of the credit.
DEADLINES = (0, 3, 7, 14, 21)             # Close with this many calendar days left (0: expiry).
FILTERS = ('none', 'uptrend', 'rich')     # uptrend: SPY above its 200-day average; rich: VIX >= 1.2x realized.
MIN_TRADES = 300


def daily(symbol: str) -> list[tuple]:
    """[(date, close)] since 1993 from Yahoo, cached for 12 hours."""
    p = CACHE / f'{symbol.strip("^")}-1d-long.json'
    if not p.exists() or time.time() - p.stat().st_mtime > 12 * 3600:
        import requests
        r = requests.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}',
                         params={'period1': 725846400, 'period2': int(time.time()), 'interval': '1d'},
                         timeout=60, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        res = r.json()['chart']['result'][0]
        closes = res['indicators']['quote'][0]['close']
        rows = [(datetime.fromtimestamp(ts, timezone.utc).date().isoformat(), c)
                for ts, c in zip(res['timestamp'], closes) if c]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rows))
    return [(date.fromisoformat(d), float(c)) for d, c in json.loads(p.read_text())]


def history() -> dict:
    spy, vix, bill = dict(daily('SPY')), dict(daily('^VIX')), dict(daily('^IRX'))
    days = sorted(d for d in spy if d in vix)
    rate, last = [], 3.0
    for d in days:  # The 13-week T-bill, carried over its missing days.
        last = bill.get(d, last)
        rate.append(last / 100)
    spot, vol = np.array([spy[d] for d in days]), np.array([vix[d] for d in days])
    sma200 = np.convolve(spot, np.ones(200) / 200, 'full')[:len(spot)]
    logret = np.diff(np.log(spot), prepend=np.log(spot[0]))
    realized = np.array([logret[max(k - 19, 1):k + 1].std(ddof=1) * math.sqrt(252) if k > 21 else np.nan
                         for k in range(len(spot))])
    return {'days': days, 'spot': spot, 'vix': vol, 'rate': np.array(rate), 'uptrend': spot > sma200, 'rich': vol / 100 >= 1.2 * realized}


def fit_surface(vix_then: float, path: Path = CHAIN) -> dict:
    """{'days', 'level'}: at-the-money iv / VIX by calendar days to expiry, and
    'put'/'call': (z grid, iv / atm iv), z = ln(strike / price) / (atm iv x sqrt(years))."""
    chain = og.parse_chain(json.loads(gzip.decompress(path.read_bytes())))
    asof = chain['asof']
    by_expiry = defaultdict(list)
    for o in chain['options']:
        by_expiry[o['expiry']].append(o)
    from strategy_lab import implied_spot
    spot = implied_spot(chain, by_expiry)
    levels = []
    points = {(side, b): defaultdict(list) for side in ('put', 'call') for b in range(len(SKEW_BUCKETS))}
    for expiry, options in sorted(by_expiry.items()):
        days = (expiry - asof.date()).days
        if not 3 <= days <= 90:
            continue
        near = sorted(options, key=lambda o: abs(o['strike'] - spot))[:4]
        atm = float(np.median([o['iv'] for o in near if 0.03 < o['iv'] < 3] or [0]))
        if not atm:
            continue
        levels.append((days, atm / (vix_then / 100)))
        years = og.years_to(expiry, asof)
        for o in options:
            side = 'call' if o['call'] else 'put'
            if o['bid'] <= 0 or not 0.03 < o['iv'] < 3 or (o['strike'] < spot) == o['call']:
                continue
            z = math.log(o['strike'] / spot) / (atm * math.sqrt(years))
            if -5 <= z <= 5:
                points[side, skew_bucket(days)][round(z * 4) / 4].append(o['iv'] / atm)
    levels.sort()
    surface = {'days': np.array([d for d, _ in levels], float), 'level': np.array([v for _, v in levels]),
               'asof': asof.strftime('%Y-%m-%d %H:%M'), 'spot': spot}
    for key, by_z in points.items():
        zs = sorted(by_z)
        surface[key] = (np.array(zs), np.array([float(np.median(by_z[z])) for z in zs]))
    return surface


def skew_bucket(days):
    return np.minimum(np.searchsorted(SKEW_BUCKETS, days, 'left'), len(SKEW_BUCKETS) - 1)


def skew(surface, side, z, days):
    """iv / atm iv at z, from the skew of expiries like this one (short ones are steeper)."""
    days = np.broadcast_to(np.asarray(days), np.shape(z))
    out = np.empty(np.shape(z))
    buckets = skew_bucket(days)
    for b in range(len(SKEW_BUCKETS)):
        here = buckets == b
        if here.any():
            zs, ratios = surface[side, b]
            out[here] = np.interp(np.asarray(z)[here], zs, ratios)
    return out


def atm_vol(surface, vix, days_left):
    return np.asarray(vix) / 100 * np.interp(days_left, surface['days'], surface['level'])


def leg(surface, side, spot, strike, years, atm, rate=0.0, days=None):
    """Black's price on the forward: rates lift the forward (puts cheaper), dividends lower it."""
    forward = spot * np.exp((rate - DIVIDEND) * years)
    z = np.log(strike / spot) / (atm * np.sqrt(np.maximum(years, 1e-9)))
    days = np.round(np.asarray(years) * 365) if days is None else days
    return np.exp(-rate * years) * bs(forward, strike, years, atm * skew(surface, side, z, days), side == 'call')


def build(h: dict, surface: dict, dte: int, delta: float, side: str, width: float) -> dict:
    """All entries for one (expiry, delta, side, width): credit, and the mid and the
    calendar days left at each later close (a matrix, NaN past expiry)."""
    days, spot, vix = h['days'], h['spot'], h['vix']
    ordinal = np.array([d.toordinal() for d in days])
    n = len(days)
    horizon = int(dte * 252 / 365) + 4
    entries = np.arange(200, n - horizon)
    steps = np.arange(horizon + 1)
    idx = np.minimum(entries[:, None] + steps[None, :], n - 1)
    # Expiry: the last trading day on or before entry + dte (it settles at that close).
    settle = np.searchsorted(ordinal, ordinal[entries] + dte, 'right') - 1 - entries
    left = ordinal[entries + settle][:, None] - ordinal[idx]     # Calendar days left at each close.
    live = steps[None, :] <= settle[:, None]
    scale = spot[-1] / spot[entries]                             # Today's dollars.
    path = spot[idx] * scale[:, None]
    s0 = path[:, 0]
    years = np.maximum(left, 0) / 365
    atm = atm_vol(surface, vix[idx], np.maximum(left, 1))
    # Short strike: whole dollar nearest the target delta.
    y0, a0 = dte / 365, atm[:, 0]
    sign = 1 if side == 'call' else -1
    grid = np.round(s0)[:, None] + sign * np.arange(1, 160)[None, :]
    z = np.log(grid / s0[:, None]) / (a0[:, None] * math.sqrt(y0))
    v = a0[:, None] * skew(surface, side, z, dte)
    d1 = (np.log(s0[:, None] / grid) + 0.5 * v * v * y0) / (v * math.sqrt(y0))
    deltas = ncdf(d1) if side == 'call' else 1 - ncdf(d1)
    short = grid[np.arange(len(entries)), np.argmin(np.abs(deltas - delta), axis=1)]
    long = short + sign * width
    rate = h['rate'][idx]
    mid = (leg(surface, side, path, short[:, None], years, atm, rate)
           - leg(surface, side, path, long[:, None], years, atm, rate))
    mid = np.where(live, mid, np.nan)
    return {'entries': entries, 'mid': mid, 'left': np.where(live, left, -1), 'credit': mid[:, 0] - SLIP,
            'width': width, 'year': np.array([days[k].year for k in entries]),
            'early': np.array([days[k] < SPLIT for k in entries]),
            'uptrend': h['uptrend'][entries], 'rich': h['rich'][entries]}


def exits(b: dict, target, stop, deadline) -> np.ndarray:
    """Dollars per spread for every entry under one set of exit rules."""
    mid, left, entry = b['mid'], b['left'], b['mid'][:, 0]
    rows = np.arange(len(mid))
    last = (left >= 0).sum(axis=1) - 1                          # The settlement column.
    rule = np.zeros_like(mid, dtype=bool)
    if target is not None:
        rule |= mid <= (1 - target) * entry[:, None]
    if stop is not None:
        rule |= mid >= stop * entry[:, None]
    if deadline:
        rule |= (left <= deadline) & (left >= 0)
    rule &= left >= 0
    rule[:, 0] = False
    first = np.where(rule.any(axis=1), rule.argmax(axis=1), last)
    first = np.minimum(first, last)
    out = mid[rows, first]
    settles = first == last
    cost = np.where(settles, np.maximum(out, 0), out + SLIP)    # Held to expiry: intrinsic, no spread to cross.
    cost = np.minimum(cost, b['width'])
    return (b['credit'] - cost) * 100 - np.where(settles, 2, 4) * FEE


def summary(pnl: np.ndarray, risk: np.ndarray) -> dict:
    if not len(pnl):
        return {'n': 0}
    wins = pnl > 0
    return {'n': int(len(pnl)), 'win_rate': round(float(wins.mean()), 3), 'per_trade': round(float(pnl.mean()), 2),
            'on_risk': round(float(pnl.sum() / risk.sum() * 100), 2),   # Cents per $1 at risk, per trade.
            'avg_win': round(float(pnl[wins].mean()), 2) if wins.any() else 0.0,
            'avg_loss': round(float(pnl[~wins].mean()), 2) if (~wins).any() else 0.0,
            'worst': round(float(pnl.min()), 2)}


def one_at_a_time(b: dict, pnl: np.ndarray, target, stop, deadline, mask) -> dict:
    """Run it the way a small account would: one spread open at a time. Equity path stats."""
    mid, left, entry = b['mid'], b['left'], b['mid'][:, 0]
    k, total, peak, worst_dd, trades, by_year = 0, 0.0, 0.0, 0.0, 0, defaultdict(float)
    n = len(pnl)
    while k < n:
        if not mask[k]:
            k += 1
            continue
        total += pnl[k]
        trades += 1
        by_year[int(b['year'][k])] += float(pnl[k])
        peak = max(peak, total)
        worst_dd = min(worst_dd, total - peak)
        row = left[k]
        held = int((row >= 0).sum())
        rule = np.zeros(len(row), bool)
        live = row >= 0
        if target is not None:
            rule |= mid[k] <= (1 - target) * entry[k]
        if stop is not None:
            rule |= mid[k] >= stop * entry[k]
        if deadline:
            rule |= (row <= deadline) & live
        rule[0] = False
        rule &= live
        held = int(rule.argmax()) if rule.any() else held - 1
        k += max(held, 1) + 1
    return {'trades': trades, 'total': round(total, 2), 'worst_drawdown': round(worst_dd, 2),
            'losing_years': sum(1 for v in by_year.values() if v < 0), 'years': len(by_year),
            'by_year': {y: round(v, 2) for y, v in sorted(by_year.items())}}


def run(log=print) -> dict:
    started = time.time()
    h = history()
    vix_then = h['vix'][[d.isoformat() for d in h['days']].index('2026-10-22')]
    surface = fit_surface(float(vix_then))
    rows = []
    for dte, delta, side, width in product(DTES, DELTAS, SIDES, WIDTHS):
        b = build(h, surface, dte, delta, side, width)
        ok = b['credit'] >= 0.05
        risk = np.maximum(width - b['credit'], 0.01) * 100
        for target, stop, deadline in product(TARGETS, STOPS, DEADLINES):
            if deadline >= dte:
                continue
            pnl = exits(b, target, stop, deadline)
            for f in FILTERS:
                mask = ok & (True if f == 'none' else b[f])
                early, late = mask & b['early'], mask & ~b['early']
                rule = {'dte': dte, 'delta': delta, 'side': side, 'width': width, 'target': target, 'stop': stop,
                        'deadline': deadline, 'filter': f}
                rows.append({**rule, 'early': summary(pnl[early], risk[early]), 'late': summary(pnl[late], risk[late]),
                             'credit': round(float(np.median(b['credit'][mask])) if mask.any() else 0, 2)})
        log(f'{dte}d {delta} {side} ${width:g}: {len(rows)} rule sets, {time.time() - started:.0f}s')
    lab = {'rows': rows, 'surface': {'asof': surface['asof'], 'vix': float(vix_then),
                                     'level': dict(zip(surface['days'].astype(int).tolist(), surface['level'].round(3).tolist()))},
           'seconds': round(time.time() - started)}
    lab['picked'] = pick(rows)
    lab['paths'] = {}
    for r in lab['picked'][:6] + [classic(rows)]:
        b = build(h, surface, r['dte'], r['delta'], r['side'], r['width'])
        mask = (b['credit'] >= 0.05) & (True if r['filter'] == 'none' else b[r['filter']])
        pnl = exits(b, r['target'], r['stop'], r['deadline'])
        lab['paths'][describe(r)] = {'early': one_at_a_time(b, pnl, r['target'], r['stop'], r['deadline'], mask & b['early']),
                                     'late': one_at_a_time(b, pnl, r['target'], r['stop'], r['deadline'], mask & ~b['early'])}
    RESULTS.write_text(json.dumps(lab, default=str))
    return lab


def pick(rows: list[dict], top: int = 15) -> list[dict]:
    """Chosen on 1993-2009 only: most return on risk among rules that win 75%+."""
    good = [r for r in rows if r['early'].get('n', 0) >= MIN_TRADES and r['early']['win_rate'] >= 0.75]
    return sorted(good, key=lambda r: -r['early']['on_risk'])[:top]


def classic(rows):
    """The common rule of thumb: 45 days, 16 delta, take 50% or close at 21 days."""
    return next(r for r in rows if (r['dte'], r['delta'], r['side'], r['width'], r['target'], r['stop'], r['deadline'], r['filter'])
                == (45, 0.16, 'put', 5.0, 0.5, None, 21, 'none'))


def describe(r: dict) -> str:
    target = f"take {int(r['target'] * 100)}%" if r['target'] else 'no target'
    stop = f"stop {r['stop']:g}x" if r['stop'] else 'no stop'
    deadline = f"close at {r['deadline']}d left" if r['deadline'] else 'hold to expiry'
    return (f"{r['side']} {r['dte']}d, {int(r['delta'] * 100)} delta, ${r['width']:g} wide, {target}, {stop}, "
            f"{deadline}, filter {r['filter']}")


if __name__ == '__main__':
    lab = run()
    print(json.dumps({'picked': [{'rule': describe(r), 'early': r['early'], 'late': r['late']} for r in lab['picked']],
                      'paths': lab['paths']}, indent=1, default=str))
