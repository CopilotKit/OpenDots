"""Algorithm lab: can anything beat the two yes/no rules?

An exam, so that trying many algorithms does not fool us:
- Train (days before 2025-11-20): every algorithm learns here, and only here.
- Validation (2025-11-20 to 2026-07-17): the algorithms are compared here, and
  one winner is picked.
- Final exam (from 2026-07-20): used once, for the winner and the rules.

Each algorithm picks at most one trade a day from the edge finder's modeled
credit spreads ($1 wide, 2 or 5 trading days, 0.15/0.20 delta, puts or calls,
four entry times), one contract, managed with a 3x stop as the rules are.
Results are counted by day.

Run: python algo_lab.py   (writes "Algorithm Lab.md" to the vault)
"""
from __future__ import annotations

import json
import pickle
from datetime import datetime
from itertools import product

import numpy as np

import edge_finder as ef
import strategy_lab as sl
import vol_model as vm

TRAIN_END, EXAM_START = '2025-11-20', '2026-07-20'
EXIT = vm.EXIT
CACHE = sl.RESULTS.with_name('algo-trades.pkl')
REPORT = sl.REPORT.with_name('Algorithm Lab.md')
RESULTS = sl.RESULTS.with_name('algo-lab.json')
FEW = ('vol_gap', 'vix_vs_20d', 'ma20_z', 'calm')  # The signals with a reason to matter.


# Data ---------------------------------------------------------------------------
def trades(log=print) -> list[dict]:
    """The modeled trades with their features (cached: building them takes minutes)."""
    if CACHE.exists() and CACHE.stat().st_mtime > max(p.stat().st_mtime for p in (sl.edge_lab.CACHE / 'SPY-1h.json',)):
        return pickle.loads(CACHE.read_bytes())
    history = sl.load(interval='1h')
    now = {t: list(d.values())[-1][-1]['index'] for t, d in history.items()}
    surfaces = {t: sl.fit_surface(t, now[t]) for t in history}
    forecasts = {(t, h): vm.har_forecasts(vm.realized(days), h) for t, days in history.items() for h in (2, 5)}
    out = []
    for t in ef.collect(history, surfaces, log=log):
        x = vm.features(t, forecasts[(t['ticker'], 2 if t['dte'] <= 2 else 5)].get(t['day']))
        if x is not None:
            out.append({**t, 'x': x, 'y': t['pnl'][EXIT]})
    CACHE.write_bytes(pickle.dumps(out))
    return out


def period(rows: list[dict], start: str, end: str) -> list[dict]:
    return [r for r in rows if start <= r['day'] < end]


def first_each_day(rows: list[dict], take) -> list[tuple[str, float]]:
    """The earliest trade each day that `take` accepts (as the autopilot would act)."""
    picked = {}
    for r in sorted(rows, key=lambda r: (r['day'], r['c']['time'])):
        if r['day'] not in picked and take(r):
            picked[r['day']] = r['y']
    return list(picked.items())


def best_each_day(rows: list[dict], score, cut: float) -> list[tuple[str, float]]:
    best = {}
    for r, s in zip(rows, score(rows)):
        if s >= cut and (r['day'] not in best or s > best[r['day']][0]):
            best[r['day']] = (s, r['y'])
    return [(d, y) for d, (_, y) in best.items()]


def total(picks) -> float:
    return sum(p for _, p in picks)


# The algorithms (each learns from `train` only and returns a picker) ------------------
def rules(train):
    def take(r):
        fear = r['side'] == 'put' and r['dte'] == 2 and r['delta'] == 0.15 and r['c']['vix_vs_20d'] < -0.0474
        stretched = r['side'] == 'call' and r['dte'] == 5 and r['delta'] == 0.20 and r['c']['ma20_z'] >= 1.38
        return fear or stretched
    return lambda rows: first_each_day(rows, take)


def rules_retuned(train):
    """The same two rules, their thresholds, deltas and entry time re-chosen on the training days."""
    best = {}
    for side, dte, feature, sense in (('put', 2, 'vix_vs_20d', -1), ('call', 5, 'ma20_z', 1)):
        options = []
        values = np.array([r['c'][feature] for r in train])
        for q, delta, at in product((0.1, 0.2, 0.33, 0.5), (0.15, 0.20), (570, 630, 750, 870)):
            cut = float(np.quantile(values, q if sense < 0 else 1 - q))
            take = (lambda r, side=side, dte=dte, delta=delta, at=at, cut=cut, f=feature, s=sense:
                    r['side'] == side and r['dte'] == dte and r['delta'] == delta and r['c']['time'] == at
                    and (r['c'][f] < cut if s < 0 else r['c'][f] >= cut))
            picks = first_each_day(train, take)
            if len(picks) >= 40:
                setting = (f'{side}s, {dte} days out, {delta:.2f} delta, at {at // 60}:{at % 60:02d}, '
                           f'{feature} {"<" if sense < 0 else ">="} {cut:.3g}')
                options.append((total(picks), take, setting))
        top = max(options, key=lambda o: o[0])
        best[side] = top[1]
        rules_retuned.settings[side] = top[2]
    return lambda rows: first_each_day(rows, lambda r: best['put'](r) or best['call'](r))


rules_retuned.settings = {}


def rules_filtered_by_score(train):
    """The rules, but a rule day is traded only if the ridge score also expects a profit."""
    model = vm.ridge(np.array([r['x'] for r in train]), np.array([r['y'] for r in train]))
    rule = rules(train)
    def pick(rows):
        scores = {id(r): s for r, s in zip(rows, model([r['x'] for r in rows]))}
        candidates = [r for r in rows if scores[id(r)] > 0]
        return rule(candidates)
    return pick


def rules_plus_moods(train):
    """The rules, plus up to two more single-condition rules for other market moods, each found on
    the training days (the edge finder's method) and added only if it raises the training total."""
    base = rules(train)
    chosen = []
    candidates = []
    for side, dte, delta in product(('put', 'call'), (2, 5), (0.15, 0.20)):
        family = [r for r in train if r['side'] == side and r['dte'] == dte and r['delta'] == delta]
        for feature in ('vix_vs_20d', 'vix_today', 'ma20_z', 'calm', 'prior_day', 'gap', 'intraday', 'iv_rv'):
            values = np.array([r['c'][feature] for r in family])
            for q in (1 / 3, 2 / 3):
                cut = float(np.quantile(values, q))
                for below in (True, False):
                    take = (lambda r, side=side, dte=dte, delta=delta, f=feature, cut=cut, below=below:
                            r['side'] == side and r['dte'] == dte and r['delta'] == delta
                            and (r['c'][f] < cut if below else r['c'][f] >= cut))
                    picks = first_each_day(family, take)
                    if len(picks) >= 60 and np.mean([p > 0 for _, p in picks]) >= 0.85 and total(picks) / len(picks) >= 3:
                        candidates.append(take)
    current = base(train)
    for _ in range(2):
        best, best_total = None, total(current)
        for take in candidates:
            extra = first_each_day(train, take)
            have = {d for d, _ in current}
            trial = current + [(d, p) for d, p in extra if d not in have]
            if total(trial) > best_total:
                best, best_total = take, total(trial)
        if best is None:
            break
        chosen.append(best)
        have = {d for d, _ in current}
        current += [(d, p) for d, p in first_each_day(train, best) if d not in have]

    def pick(rows):
        out = dict(base(rows))
        for take in chosen:
            for d, p in first_each_day(rows, take):
                out.setdefault(d, p)
        return list(out.items())
    return pick


def logistic(train):
    """Win probability from the few signals with a reason to matter, per side; best trade a
    day if its probability clears the cut that made the most on the training days."""
    idx = [vm.SIGNALS.index(s) for s in FEW]
    X = np.array([[r['x'][i] for i in idx] + [1.0 if r['side'] == 'put' else 0.0, 1.0 if r['dte'] == 5 else 0.0]
                  for r in train])
    y = np.array([1.0 if r['y'] > 0 else 0.0 for r in train])
    mean, scale = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = np.hstack([(X - mean) / scale, np.ones((len(X), 1))])
    w = np.zeros(Z.shape[1])
    for _ in range(400):  # Gradient descent with a little L2.
        p = 1 / (1 + np.exp(-Z @ w))
        w -= 0.5 * (Z.T @ (p - y) / len(y) + 0.01 * w)
    def score(rows):
        A = np.array([[r['x'][i] for i in idx] + [1.0 if r['side'] == 'put' else 0.0, 1.0 if r['dte'] == 5 else 0.0]
                      for r in rows])
        return 1 / (1 + np.exp(-np.hstack([(A - mean) / scale, np.ones((len(A), 1))]) @ w))
    cut = max(np.quantile(score(train), [0.5, 0.7, 0.8, 0.9, 0.95]), key=lambda c: total(best_each_day(train, score, c)))
    return lambda rows: best_each_day(rows, score, float(cut))


class Tree:
    """A small regression tree on profit (CART: splits at deciles, a minimum leaf size)."""

    def __init__(self, depth=3, leaf=150, features=None, rng=None):
        self.depth, self.leaf, self.features, self.rng = depth, leaf, features, rng

    def fit(self, X, y):
        self.node = self._grow(X, y, self.depth)
        return self

    def _grow(self, X, y, depth):
        if depth == 0 or len(y) < 2 * self.leaf:
            return float(y.mean())
        best = None
        columns = range(X.shape[1]) if self.features is None else self.rng.choice(X.shape[1], self.features, replace=False)
        for j in columns:
            for cut in np.unique(np.quantile(X[:, j], np.linspace(0.1, 0.9, 9))):
                left = X[:, j] < cut
                n = left.sum()
                if n < self.leaf or len(y) - n < self.leaf:
                    continue
                sse = ((y[left] - y[left].mean()) ** 2).sum() + ((y[~left] - y[~left].mean()) ** 2).sum()
                if best is None or sse < best[0]:
                    best = (sse, j, cut, left)
        if best is None:
            return float(y.mean())
        _, j, cut, left = best
        return (j, cut, self._grow(X[left], y[left], depth - 1), self._grow(X[~left], y[~left], depth - 1))

    def predict(self, X):
        def one(x, node):
            while isinstance(node, tuple):
                node = node[2] if x[node[0]] < node[1] else node[3]
            return node
        return np.array([one(x, self.node) for x in X])


def matrix(rows):
    return np.array([r['x'] for r in rows])


def tree(train):
    model = Tree().fit(matrix(train), np.array([r['y'] for r in train]))
    score = lambda rows: model.predict(matrix(rows))
    return lambda rows: best_each_day(rows, score, 0.0)


def forest(train):
    rng = np.random.default_rng(7)
    X, y = matrix(train), np.array([r['y'] for r in train])
    days = sorted({r['day'] for r in train})
    trees = []
    for _ in range(25):  # Bagging by whole days, so a day's overlapping trades stay together.
        keep = set(rng.choice(days, len(days), replace=True))
        mask = np.array([r['day'] in keep for r in train])
        trees.append(Tree(depth=3, leaf=120, features=6, rng=rng).fit(X[mask], y[mask]))
    score = lambda rows: np.mean([t.predict(matrix(rows)) for t in trees], axis=0)
    return lambda rows: best_each_day(rows, score, 0.0)


ALGORITHMS = {
    'Yes/no rules (current)': rules,
    'Rules, thresholds re-tuned': rules_retuned,
    'Rules, only when the score agrees': rules_filtered_by_score,
    'Rules plus rules for other moods': rules_plus_moods,
    'Win-probability model (4 signals)': logistic,
    'Decision tree': tree,
    'Random forest (25 trees)': forest,
}


def run(log=print) -> dict:
    rows = trades(log)
    train = period(rows, '0000', TRAIN_END)
    valid = period(rows, TRAIN_END, EXAM_START)
    exam = period(rows, EXAM_START, '9999')
    days = lambda part: sorted({r['day'] for r in part})
    results = {}
    for name, algorithm in ALGORITHMS.items():
        pick = algorithm(train)
        results[name] = {'train': vm.by_day(pick(train), days(train)), 'validation': vm.by_day(pick(valid), days(valid)),
                         '_pick': pick}
        log(f'{name}: validation ${results[name]["validation"]["total"]:+.0f}')
    challengers = {k: v for k, v in results.items() if k != 'Yes/no rules (current)'}
    winner = max(challengers, key=lambda k: challengers[k]['validation']['total'])
    for name in (winner, 'Yes/no rules (current)'):  # The final exam: once, for these two only.
        results[name]['exam'] = vm.by_day(results[name]['_pick'](exam), days(exam))
    for r in results.values():
        r.pop('_pick')
    return {'periods': {'train': [days(train)[0], days(train)[-1]], 'validation': [days(valid)[0], days(valid)[-1]],
                        'exam': [days(exam)[0], days(exam)[-1]]},
            'winner': winner, 'results': results, 'retuned_settings': dict(rules_retuned.settings)}


def report(lab: dict) -> str:
    def cell(r):
        return (f'{r["traded"]} of {r["days"]} / {r["share_of_traded_days_profitable"]:.0%} / ${r["per_traded_day"]:+.2f} / '
                f'${r["total"]:+,.0f} / {r["losing_weeks"]} of {r["weeks"]}')
    p = lab['periods']
    winner, rules_ = lab['results'][lab['winner']], lab['results']['Yes/no rules (current)']
    beat = winner['exam']['total'] > rules_['exam']['total']
    lines = ['---', 'tags:', '  - "trading"', '  - "algorithm-lab"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Algorithm Lab', '',
             f'Can an algorithm beat the two yes/no rules? Every algorithm learned on {p["train"][0]} to {p["train"][1]}, '
             f'was compared on {p["validation"][0]} to {p["validation"][1]} (validation), and the best one met the rules '
             f'once on {p["exam"][0]} to {p["exam"][1]} (the final exam, untouched until then). One trade a day at most, '
             '$1-wide credit spreads, modeled option prices, costs off the mid.', '',
             f'## Final exam: **{lab["winner"]}** vs the rules', '',
             '| | Days traded / profitable / $ a traded day / total / losing weeks |', '|---|---|',
             f'| {lab["winner"]} | {cell(winner["exam"])} |', f'| Yes/no rules | {cell(rules_["exam"])} |', '',
             f'**{"The challenger made more on the final exam." if beat else "The rules held: nothing beat them on the final exam."}**', '',
             *([f'Re-tuned rule settings (chosen on the training days): {"; ".join(lab["retuned_settings"].values())}.', '']
               if lab.get('retuned_settings') else []),
             '## Validation (where the winner was picked)', '',
             '| Algorithm | Training | Validation |', '|---|---|---|',
             *[f'| {name} | {cell(r["train"])} | {cell(r["validation"])} |' for name, r in lab['results'].items()], '',
             '## Read with care', '',
             '- Modeled option prices, not recorded quotes; about two years of one market, mostly rising.',
             '- The validation and exam months are short; a few trades swing them. Agreement across both matters more '
             'than the biggest number.', '', 'Run again: `python localtools/algo_lab.py`.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    lab = run()
    RESULTS.write_text(json.dumps(lab, indent=1, default=str))
    REPORT.write_text(report(lab), encoding='utf-8')
    print('winner:', lab['winner'])
    for name, r in lab['results'].items():
        print(f'{name:38s} train ${r["train"]["total"]:+7.0f} ({r["train"]["traded"]}d, {r["train"]["share_of_traded_days_profitable"]:.0%})'
              f' | valid ${r["validation"]["total"]:+6.0f} ({r["validation"]["traded"]}d, {r["validation"]["share_of_traded_days_profitable"]:.0%})'
              + (f' | EXAM ${r["exam"]["total"]:+5.0f} ({r["exam"]["traded"]}d, {r["exam"]["share_of_traded_days_profitable"]:.0%}, losing weeks {r["exam"]["losing_weeks"]}/{r["exam"]["weeks"]})' if 'exam' in r else ''))
