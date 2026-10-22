"""Volatility forecast and combined trade score, tested walk-forward.

1. Forecast (HAR-RV, Corsi 2009): how much SPY/QQQ will really move over the
   next few days, from how much they moved yesterday, over the last week and over
   the last month (each day's realized variance from its hourly returns plus the
   overnight gap). Refitted every month on past days only.
2. Score: for every modeled credit spread (the edge finder's trades), a ridge
   regression estimates its profit from ~20 signals: the gap between the
   volatility the options price in and the forecast, the VIX against its
   average, price against its 20-day average, how calm the day is, yesterday's
   move, the gap, the time, the side and the days to expiry. Walk-forward: each
   month is scored by a model trained only on the months before it.
3. Each day, the single best-scored trade is taken if its score clears a
   threshold chosen on past months only. Results are counted by day: how many
   days traded, how many profitable, the worst week.

Option prices are modeled as in the strategy lab (volatility index + today's
skew, trading-time clock, checked against real prices within about 20%).

Run: python vol_model.py   (writes "Volatility Model.md" to the vault)
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime

import numpy as np

import edge_finder as ef
import strategy_lab as sl

EXIT = 'stop 3x'          # The exit both edges were tested with.
MIN_TRAIN_MONTHS = 6
RIDGE = 10.0
REPORT = sl.REPORT.with_name('Volatility Model.md')
RESULTS = sl.RESULTS.with_name('vol-model.json')


# 1. The forecast ----------------------------------------------------------------
def realized(days: dict) -> dict[str, float]:
    """Each day's realized variance: squared hourly log returns plus the squared overnight gap."""
    out, previous = {}, None
    for name in sorted(days):
        closes = [days[name][0]['o']] + [b['c'] for b in days[name]]
        variance = float(np.sum(np.diff(np.log(closes)) ** 2))
        if previous:
            variance += math.log(days[name][0]['o'] / previous) ** 2
        out[name] = variance
        previous = days[name][-1]['c']
    return out


def har_rows(rv: dict[str, float], horizon: int) -> list[tuple[str, list[float], float | None]]:
    """(day, [1, daily, weekly, monthly], average variance over the next `horizon` days or None)."""
    names = sorted(rv)
    values = np.array([rv[n] for n in names])
    rows = []
    for k in range(22, len(names)):
        x = [1.0, values[k], values[k - 4:k + 1].mean(), values[k - 21:k + 1].mean()]
        y = values[k + 1:k + 1 + horizon].mean() if k + horizon < len(names) else None
        rows.append((names[k], x, y))
    return rows


def har_forecasts(rv: dict[str, float], horizon: int) -> dict[str, float]:
    """Walk-forward: each day's forecast of annualized volatility over the next `horizon`
    trading days, from a fit on the days whose outcome was known by then."""
    rows = har_rows(rv, horizon)
    out, coef, fitted_month = {}, None, None
    for k, (name, x, _) in enumerate(rows):
        if name[:7] != fitted_month:  # Refit monthly.
            known = [(xx, yy) for nn, xx, yy in rows[:max(k - horizon, 0)] if yy is not None]
            if len(known) >= 60:
                X, y = np.array([a for a, _ in known]), np.array([b for _, b in known])
                coef = np.linalg.lstsq(X, y, rcond=None)[0]
            fitted_month = name[:7]
        if coef is not None:
            variance = max(float(np.dot(coef, x)), 1e-7)
            out[name] = math.sqrt(variance * 252)
    return out


# 2. The score -------------------------------------------------------------------
SIGNALS = ('vol_gap', 'vix_vs_20d', 'vix_today', 'ma20_z', 'calm', 'prior_day', 'gap', 'intraday', 'iv_rv')


def features(t: dict, forecast: float | None) -> list[float] | None:
    """One trade's numbers for the score. Direction signals are signed so that "good for
    this side" points the same way for puts and calls (a rising market helps puts)."""
    if forecast is None:
        return None
    c = t['c']
    implied = c['vix'] / 100
    sign = 1.0 if t['side'] == 'put' else -1.0
    values = {
        'vol_gap': implied / forecast - 1,  # Options pricing more movement than forecast: the seller's edge.
        'vix_vs_20d': c['vix_vs_20d'], 'vix_today': c['vix_today'], 'ma20_z': sign * c['ma20_z'],
        'calm': c['calm'], 'prior_day': sign * c['prior_day'], 'gap': sign * c['gap'],
        'intraday': sign * c['intraday'], 'iv_rv': c['iv_rv']}
    row = [values[s] for s in SIGNALS]
    row += [1.0 if t['side'] == 'put' else 0.0, 1.0 if t['dte'] == 5 else 0.0, t['delta'],
            1.0 if c['time'] < 600 else 0.0, 1.0 if c['time'] >= 840 else 0.0,
            values['vol_gap'] * (1.0 if t['side'] == 'put' else 0.0)]
    return row


def ridge(X: np.ndarray, y: np.ndarray, alpha: float = RIDGE):
    mean, scale = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = (X - mean) / scale
    coef = np.linalg.solve(Z.T @ Z + alpha * np.eye(Z.shape[1]), Z.T @ (y - y.mean()))
    return lambda A: (np.asarray(A) - mean) / scale @ coef + y.mean()


def walk_forward(trades: list[dict], forecasts: dict) -> list[dict]:
    """Each trade with its out-of-sample score: the model used was fitted only on
    trades whose day was in an earlier month (and already finished)."""
    rows = []
    for t in trades:
        f = features(t, forecasts.get((t['ticker'], t['dte'] if t['dte'] <= 2 else 5), {}).get(t['day']))
        if f is not None:
            rows.append({**t, 'x': f, 'y': t['pnl'][EXIT]})
    months = sorted({r['day'][:7] for r in rows})
    scored = []
    for k, month in enumerate(months):
        if k < MIN_TRAIN_MONTHS:
            continue
        past = [r for r in rows if r['day'][:7] < month]
        model = ridge(np.array([r['x'] for r in past]), np.array([r['y'] for r in past]))
        now = [r for r in rows if r['day'][:7] == month]
        for r, s in zip(now, model([r['x'] for r in now])):
            scored.append({**r, 'score': float(s)})
    return scored


# 3. One trade a day, counted by day -------------------------------------------------
def by_day(picks: list[tuple[str, float]], all_days: list[str]) -> dict:
    pnl = defaultdict(float)
    for day, p in picks:
        pnl[day] += p
    traded = sorted(pnl)
    weeks = defaultdict(float)
    for day, p in pnl.items():
        weeks[datetime.strptime(day, '%Y-%m-%d').strftime('%G-W%V')] += p
    profitable = sum(v > 0 for v in pnl.values())
    return {'days': len(all_days), 'traded': len(traded), 'profitable_days': profitable,
            'share_of_traded_days_profitable': round(profitable / len(traded), 3) if traded else 0,
            'share_of_all_days_profitable': round(profitable / len(all_days), 3) if all_days else 0,
            'total': round(sum(pnl.values()), 2), 'per_traded_day': round(sum(pnl.values()) / len(traded), 2) if traded else 0,
            'worst_day': round(min(pnl.values()), 2) if pnl else 0,
            'worst_week': min(weeks.items(), key=lambda w: w[1]) if weeks else None,
            'losing_weeks': sum(v < 0 for v in weeks.values()), 'weeks': len(weeks)}


def daily_best(scored: list[dict], threshold: float) -> list[tuple[str, float]]:
    best = {}
    for r in scored:
        if r['score'] >= threshold and (r['day'] not in best or r['score'] > best[r['day']]['score']):
            best[r['day']] = r
    return [(d, r['y']) for d, r in best.items()]


def choose_threshold(scored: list[dict], month: str) -> float:
    """The cut that would have made the most on the months before `month` (past only)."""
    past = [r for r in scored if r['day'][:7] < month]
    if len(past) < 200:
        return 0.0
    best, best_total = 0.0, -1e9
    for cut in np.quantile([r['score'] for r in past], [0.5, 0.7, 0.8, 0.9, 0.95, 0.98]):
        total = sum(p for _, p in daily_best(past, float(cut)))
        if total > best_total:
            best, best_total = float(cut), total
    return best


RULES_FOUND = '2025-11-20'  # The edge finder chose the two rules on days before this.


def evaluate(scored: list[dict], since: str = '') -> dict:
    """since: count only days from then (the thresholds still learn from the earlier months)."""
    if since:
        full = evaluate(scored)
        all_days = sorted({r['day'] for r in scored if r['day'] >= since})
        out = {'from': all_days[0], 'to': all_days[-1], 'thresholds': full['thresholds']}
        for name, picks in full['picks'].items():
            out[name] = by_day([p for p in picks if p[0] >= since], all_days)
        return out
    all_days = sorted({r['day'] for r in scored})
    months = sorted({d[:7] for d in all_days})
    model_picks, cuts = [], {}
    for month in months:
        cut = choose_threshold(scored, month)
        cuts[month] = round(cut, 2)
        model_picks += daily_best([r for r in scored if r['day'][:7] == month], cut)
    # Comparisons on the same days: one trade every day (the best of nothing: the first
    # put spread at 9:30), and the two yes/no rules.
    every = {}
    rules = {}
    for r in sorted(scored, key=lambda r: r['c']['time']):
        if r['side'] == 'put' and r['dte'] == 2 and r['delta'] == 0.15:
            every.setdefault(r['day'], r['y'])
        fear = r['side'] == 'put' and r['dte'] == 2 and r['delta'] == 0.15 and r['c']['vix_vs_20d'] < -0.0474
        stretched = r['side'] == 'call' and r['dte'] == 5 and r['delta'] == 0.20 and r['c']['ma20_z'] >= 1.38
        if fear or stretched:
            rules.setdefault(r['day'], r['y'])
    picks = {'model': model_picks, 'every_day': list(every.items()), 'rules': list(rules.items())}
    return {'from': all_days[0], 'to': all_days[-1], 'thresholds': cuts, 'picks': picks,
            **{name: by_day(p, all_days) for name, p in picks.items()}}


def importance(scored: list[dict]) -> list[tuple[str, float]]:
    """How much each signal moves the score in the final model (standardized weights)."""
    X, y = np.array([r['x'] for r in scored]), np.array([r['y'] for r in scored])
    Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
    coef = np.linalg.solve(Z.T @ Z + RIDGE * np.eye(Z.shape[1]), Z.T @ (y - y.mean()))
    names = list(SIGNALS) + ['put side', '5 days out', 'delta', 'morning entry', 'afternoon entry', 'vol gap on puts']
    return sorted(zip(names, (round(float(c), 2) for c in coef)), key=lambda p: -abs(p[1]))


def forecast_check(history: dict) -> dict:
    """How good the forecast is: its error against what then happened, next to the
    naive forecast (last month's volatility), on the same days."""
    out = {}
    for ticker, days in history.items():
        rv = realized(days)
        rows = {n: y for n, _, y in har_rows(rv, 5) if y is not None}
        har = har_forecasts(rv, 5)
        names = sorted(rv)
        naive = {names[k]: math.sqrt(np.mean([rv[n] for n in names[k - 21:k + 1]]) * 252) for k in range(22, len(names))}
        common = [n for n in har if n in rows and n in naive]
        actual = np.array([math.sqrt(rows[n] * 252) for n in common])
        err = lambda f: float(np.mean(np.abs(np.array([f[n] for n in common]) - actual)))
        out[ticker] = {'days': len(common), 'har_error': round(err(har), 4), 'naive_error': round(err(naive), 4)}
    return out


def report(result: dict) -> str:
    def line(name, r):
        week = f'{r["worst_week"][0]} ${r["worst_week"][1]:+.0f}' if r['worst_week'] else '-'
        return (f'| {name} | {r["traded"]} of {r["days"]} | {r["share_of_traded_days_profitable"]:.0%} | '
                f'${r["per_traded_day"]:+.2f} | ${r["total"]:+,.0f} | ${r["worst_day"]:+.0f} | {week} | '
                f'{r["losing_weeks"]} of {r["weeks"]} |')
    e, fair = result['evaluation'], result['unseen_by_rules']
    check = result['forecast_check']
    table = lambda r: ['| Approach | Days traded | Traded days profitable | $ a traded day | Total | Worst day | Worst week | Losing weeks |',
                       '|---|---|---|---|---|---|---|---|',
                       line('Combined score (best trade of the day, if it scores high enough)', r['model']),
                       line('Yes/no rules (the two edges)', r['rules']),
                       line('Every day (2-day 0.15-delta put spread at 9:30)', r['every_day'])]
    lines = ['---', 'tags:', '  - "trading"', '  - "vol-model"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Volatility Model', '',
             f'The fair comparison: {fair["from"]} to {fair["to"]}, days none of the three had seen (the rules were '
             f'chosen on days before {fair["from"]}; the score is retrained each month on earlier months only). One '
             'trade a day at most, $1-wide spreads, modeled option prices, costs off the mid.', '',
             *table(fair), '',
             f'All scored days, {e["from"]} to {e["to"]} (the rules\' figures here include days they were chosen on):', '',
             *table(e), '',
             '## The forecast', '',
             *[f'- {t}: average error {c["har_error"]:.1%} volatility points (HAR) vs {c["naive_error"]:.1%} (last month\'s '
               f'volatility), over {c["days"]} days.' for t, c in check.items()], '',
             '## What the score leans on (final model, standardized weights)', '',
             *[f'- {n}: {w:+.2f}' for n, w in result['importance'][:10]], '',
             '## Read with care', '',
             '- Modeled option prices, not recorded quotes (checked within about 20% on 2026-10-21).',
             '- One contract a trade; overnight risk on 2- and 5-day spreads included.',
             '- The score is only as good as the months it learned from; it keeps learning as the dry run adds days.',
             '', 'Run again: `python localtools/vol_model.py`.']
    return '\n'.join(lines) + '\n'


def run(log=print) -> dict:
    history = sl.load(interval='1h')
    now = {t: list(d.values())[-1][-1]['index'] for t, d in history.items()}
    surfaces = {t: sl.fit_surface(t, now[t]) for t in history}
    forecasts = {}
    for ticker, days in history.items():
        rv = realized(days)
        for horizon in (2, 5):
            forecasts[(ticker, horizon)] = har_forecasts(rv, horizon)
    trades = ef.collect(history, surfaces, log=log)
    scored = walk_forward(trades, forecasts)
    log(f'{len(scored)} trades scored out of sample')
    every = evaluate(scored)
    every.pop('picks')
    return {'evaluation': every, 'unseen_by_rules': evaluate(scored, RULES_FOUND),
            'forecast_check': forecast_check(history), 'importance': importance(scored)}


if __name__ == '__main__':
    result = run()
    RESULTS.write_text(json.dumps(result, indent=1, default=str))
    REPORT.write_text(report(result), encoding='utf-8')
    print(json.dumps({k: result['evaluation'][k] for k in ('model', 'rules', 'every_day')}, indent=1, default=str))
    print(result['forecast_check'])
    print(result['importance'][:8])
