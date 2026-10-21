"""Edge finder: which market conditions make the credit spreads that held up in
the strategy lab (2-5 day, 0.15-0.20 delta, $1 wide) win more and make more.

Every trade on ~2 years of hourly prices is tagged with the conditions at entry
(VIX level and direction, how calm the day is, yesterday's move, the gap, where
price sits against its 20-day average, implied vs realized volatility, the day
of the week, the time). Each condition is split into thirds on the early days
(the training days), and a third counts as an edge only if it beats the
family's baseline on the early days AND on the later days it never saw. Pairs
of edges are then tested the same way.

Option prices are modeled as in the strategy lab (volatility index + today's
skew); costs off the mid.

Run: python edge_finder.py   (writes "Edge Finder.md" to the vault)
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime
from itertools import combinations, product

import numpy as np

import strategy_lab as sl

DTES = (2, 5)
DELTAS = (0.15, 0.20)
EXITS = {'hold': (None, None, False), 'stop 3x': (None, 3.0, False), 'keep 75%, stop 3x': (0.75, 3.0, False)}
MIN_TRAIN, MIN_TEST = 40, 15
WIN_LIFT, DOLLAR_LIFT = 0.03, 2.0  # An edge must beat the baseline by this much in both periods.
REPORT = sl.REPORT.with_name('Edge Finder.md')
RESULTS = sl.RESULTS.with_name('edge-finder.json')

NAMES = {
    'vix': 'VIX (VXN for QQQ) level', 'vix_vs_20d': 'VIX against its 20-day average',
    'vix_today': 'VIX change since yesterday\'s close', 'calm': 'day\'s range so far / expected daily move',
    'prior_day': 'yesterday\'s move', 'gap': 'gap at the open', 'ma20_z': 'price vs 20-day average (in std devs)',
    'intraday': 'move since the open', 'iv_rv': 'implied / realized volatility', 'weekday': 'day of the week',
    'time': 'entry time'}


def conditions(rows: list, i: int, daily: list[dict], surface: dict) -> dict:
    """The market at the entry bar. daily: earlier days' {'close', 'index_close'}, oldest first."""
    bars = rows[:i + 1]
    price, index = bars[-1]['c'], bars[-1]['index']
    closes = [d['close'] for d in daily[-20:]]
    index_closes = [d['index_close'] for d in daily[-20:]]
    returns = np.diff(np.log([d['close'] for d in daily[-21:]]))
    realized = float(returns.std(ddof=1) * math.sqrt(252)) if returns.size > 2 else None
    implied = index / 100 * surface['level'][3]
    expected = index / 100 * surface['level'][1] / math.sqrt(252) * price
    spread = float(np.std(closes, ddof=1)) if len(closes) > 2 else 0.0
    return {
        'vix': index,
        'vix_vs_20d': index / float(np.mean(index_closes)) - 1,
        'vix_today': index / index_closes[-1] - 1,
        'calm': (max(b['h'] for b in bars) - min(b['l'] for b in bars)) / expected,
        'prior_day': daily[-1]['close'] / daily[-2]['close'] - 1,
        'gap': bars[0]['o'] / daily[-1]['close'] - 1,
        'ma20_z': (price - float(np.mean(closes))) / spread if spread else 0.0,
        'intraday': price / bars[0]['o'] - 1,
        'iv_rv': implied / realized if realized else 1.0,
        'weekday': bars[-1]['t'].weekday(),
        'time': bars[-1]['t'].hour * 60 + bars[-1]['t'].minute,
    }


def collect(history: dict, surfaces: dict, times=sl.HOURLY_TIMES, log=print) -> list[dict]:
    """Every trade of the families, with its conditions and its result under each exit."""
    out = []
    for ticker, days in history.items():
        names = sorted(days)
        daily: list[dict] = []
        for d, name in enumerate(names):
            rows = days[name]
            if len(daily) >= 21:
                for at in times:
                    i = next((k for k, b in enumerate(rows) if (b['t'].hour, b['t'].minute) == at), None)
                    if i is None:
                        continue
                    c = conditions(rows, i, daily, surfaces[ticker])
                    for dte, delta, side in product(DTES, DELTAS, ('put', 'call')):
                        tr = sl.trade(days, names, d, at, dte, delta, side, surfaces[ticker])
                        if tr:
                            out.append({'ticker': ticker, 'day': name, 'dte': dte, 'delta': delta, 'side': side,
                                        'c': c, 'pnl': {k: sl.exit_pnl(tr, *e) for k, e in EXITS.items()}})
            daily.append({'close': rows[-1]['c'], 'index_close': rows[-1]['index']})
        log(f'{ticker}: {sum(t["ticker"] == ticker for t in out)} trades tagged')
    return out


def score(pnls: list[float]) -> dict:
    return sl.stats(pnls) if pnls else {'n': 0}


def beats(group: dict, base: dict) -> bool:
    return (group['n'] >= 1 and group.get('win_rate', 0) >= base['win_rate'] + WIN_LIFT
            and group.get('per_trade', -1e9) >= base['per_trade'] + DOLLAR_LIFT)


def find(trades: list[dict]) -> dict:
    days = sorted({t['day'] for t in trades})
    split = days[int(len(days) * 2 / 3)]
    families = defaultdict(list)
    for t in trades:
        for exit_ in EXITS:
            families[(t['side'], t['dte'], t['delta'], exit_)].append(t)
    edges, tables = [], {}
    for (side, dte, delta, exit_), group in families.items():
        train = [t for t in group if t['day'] < split]
        test = [t for t in group if t['day'] >= split]
        base = {'train': score([t['pnl'][exit_] for t in train]), 'test': score([t['pnl'][exit_] for t in test])}
        family = f'{dte}-day {delta:.2f}-delta {side} spreads, {exit_}'
        rows = []
        found = []
        for feature in NAMES:
            values = np.array([t['c'][feature] for t in train])
            if feature in ('weekday', 'time'):
                cuts = sorted(set(values.tolist()))
                buckets = [(f'{feature} = {v}', (lambda x, v=v, f=feature: x['c'][f] == v)) for v in cuts]
            else:
                low, high = np.quantile(values, [1 / 3, 2 / 3])
                buckets = [(f'{feature} low (< {low:.3g})', lambda x, f=feature, lo=low: x['c'][f] < lo),
                           (f'{feature} middle', lambda x, f=feature, lo=low, hi=high: lo <= x['c'][f] < hi),
                           (f'{feature} high (>= {high:.3g})', lambda x, f=feature, hi=high: x['c'][f] >= hi)]
            for label, test_fn in buckets:
                a = score([t['pnl'][exit_] for t in train if test_fn(t)])
                b = score([t['pnl'][exit_] for t in test if test_fn(t)])
                rows.append({'condition': label, 'train': a, 'test': b})
                if a['n'] >= MIN_TRAIN and b['n'] >= MIN_TEST and beats(a, base['train']) and beats(b, base['test']):
                    found.append((label, test_fn, a, b))
        # Pairs of edges: do they stack?
        pairs = []
        for (l1, f1, _, _), (l2, f2, _, _) in combinations(found, 2):
            if l1.split()[0] == l2.split()[0]:
                continue
            both = lambda x, f1=f1, f2=f2: f1(x) and f2(x)
            a = score([t['pnl'][exit_] for t in train if both(t)])
            b = score([t['pnl'][exit_] for t in test if both(t)])
            if a['n'] >= MIN_TRAIN // 2 and b['n'] >= MIN_TEST // 2 and beats(a, base['train']) and beats(b, base['test']):
                pairs.append({'condition': f'{l1} + {l2}', 'train': a, 'test': b})
        tables[family] = {'base': base, 'rows': rows}
        for label, _, a, b in found:
            edges.append({'family': family, 'condition': label, 'train': a, 'test': b, 'base': base})
        for p in pairs:
            edges.append({'family': family, **p, 'base': base, 'pair': True})
    rank = lambda e: min(e['train']['per_trade'], e['test']['per_trade']) * min(e['train']['n'] + e['test']['n'], 120)
    edges.sort(key=rank, reverse=True)
    return {'days': len(days), 'first': days[0], 'last': days[-1], 'split': split, 'trades': len(trades),
            'edges': edges, 'tables': tables}


def plain(label: str) -> str:
    feature = label.split()[0]
    return label.replace(feature, NAMES.get(feature, feature), 1)


def report(result: dict) -> str:
    def cell(s):
        return f'{s["n"]} / {s.get("win_rate", 0):.0%} / ${s.get("per_trade", 0):+.2f}' if s.get('n') else '-'
    singles = [e for e in result['edges'] if not e.get('pair')]
    pairs = [e for e in result['edges'] if e.get('pair')]
    head = ('| Family | Condition | Early days: trades / wins / $ a trade | Later days (unseen) | Family baseline (early / later) |'
            '\n|---|---|---|---|---|')
    row = lambda e: (f'| {e["family"]} | {" + ".join(plain(p) for p in e["condition"].split(" + "))} | {cell(e["train"])} | '
                     f'{cell(e["test"])} | {cell(e["base"]["train"])} / {cell(e["base"]["test"])} |')
    by_condition = defaultdict(int)
    for e in singles:
        by_condition[e['condition'].split(' (')[0]] += 1
    lines = ['---', 'tags:', '  - "trading"', '  - "edge-finder"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Edge Finder', '',
             f'{result["trades"]:,} modeled credit-spread trades on {result["days"]} trading days ({result["first"]} to '
             f'{result["last"]}), each tagged with the market at entry. A condition is an edge only if, on the early '
             f'days (before {result["split"]}) AND on the later days it never saw, it beat its family\'s baseline by '
             f'{WIN_LIFT:.0%} more wins and ${DOLLAR_LIFT:.0f} more a trade.', '',
             '## Conditions that showed up most often', '',
             *[f'- **{plain(c)}**: an edge in {n} of the {len(result["tables"])} trade families' for c, n in
               sorted(by_condition.items(), key=lambda x: -x[1])[:10]], '',
             '## Best single edges', '', head, *[row(e) for e in singles[:25]], '',
             '## Pairs that stack', '', *([head, *[row(e) for e in pairs[:20]]] if pairs else ['None passed in both periods.']),
             '', '## Read with care', '',
             '- Modeled option prices (volatility index + today\'s skew), not recorded quotes.',
             f'- Many conditions were tried: some "edges" will be luck even after both periods. Those that show up '
             'across many families, and make sense (sell premium when it is rich and the market is quiet), are '
             'the ones to trust first.',
             '- Next step for any edge: the dry-run autopilot, where it builds a real record.', '',
             'Run again: `python localtools/edge_finder.py`.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    history = sl.load(interval='1h')
    now = {t: list(d.values())[-1][-1]['index'] for t, d in history.items()}
    surfaces = {t: sl.fit_surface(t, now[t]) for t in history}
    result = find(collect(history, surfaces))
    RESULTS.write_text(json.dumps({k: v for k, v in result.items() if k != 'tables'}, indent=1, default=str))
    REPORT.write_text(report(result), encoding='utf-8')
    print(json.dumps({k: result[k] for k in ('days', 'split', 'trades')}), len(result['edges']), 'edges')
    for e in result['edges'][:15]:
        print(e['family'], '|', e['condition'], e['train'], e['test'])
