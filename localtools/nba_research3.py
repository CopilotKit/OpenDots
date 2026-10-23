"""NBA edge research, round 3: classic betting angles at DraftKings' closing prices.

Each angle is a fixed bucket (no tuning beyond picking the best bucket on the training
games), judged on the unseen games: moneyline price buckets (favourite-longshot bias),
home underdogs / road favourites against the spread, totals by size, rest matchups on
totals, and whether a team's covering rate in the first part of the season carries on.

Run: python nba_research3.py   (adds a section to "NBA Edge Research.md")
"""
from __future__ import annotations

import math
from collections import defaultdict

import nba_research as nr
import nba_research2 as r2

VAULT = nr.VAULT


def z(win_rate, bets, break_even=0.5238):
    return (win_rate - break_even) / math.sqrt(0.25 / bets) if bets else 0.0


def angles():
    def ml(r, side):
        odds = r[f'close_{side}_ml']
        if not odds:
            return None
        return nr.payout(odds) if (r['margin'] > 0) == (side == 'home') else -1.0

    def ml_bucket(lo, hi, who):
        def bet(r):
            out = []
            for side in ('home', 'away'):
                odds = r.get(f'close_{side}_ml')
                if odds and lo <= odds < hi:
                    out.append(ml(r, side))
            return out
        return bet

    def ats(side_rule):
        def bet(r):
            side = side_rule(r)
            if not side:
                return []
            return [r2.bet_spread(r['margin'], r['close_home_spread'], side, r[f'close_{side}_spread_odds'])]
        return bet

    def total_rule(fn):
        def bet(r):
            side = fn(r)
            if not side:
                return []
            return [r2.bet_total(r['points'], r['close_total'], side, r[f'close_{side}_odds'])]
        return bet

    out = {}
    for lo, hi, label in ((-10000, -500, 'heavy favourites (-500 or shorter)'), (-500, -250, 'favourites -500 to -250'),
                          (-250, -150, 'favourites -250 to -150'), (-150, 100, 'near pick\'em'),
                          (100, 200, 'underdogs +100 to +200'), (200, 400, 'underdogs +200 to +400'),
                          (400, 100000, 'big underdogs +400 or longer')):
        out[f'Moneyline: every {label}'] = ml_bucket(lo, hi, label)
    out['Spread: home underdogs'] = ats(lambda r: 'home' if r['close_home_spread'] > 0 else None)
    out['Spread: road favourites'] = ats(lambda r: 'away' if r['close_home_spread'] > 0 else None)
    out['Spread: home favourites of 7+'] = ats(lambda r: 'home' if r['close_home_spread'] <= -7 else None)
    out['Spread: road underdogs of 7+'] = ats(lambda r: 'away' if r['close_home_spread'] <= -7 else None)
    for lo, hi in ((0, 220), (220, 230), (230, 240), (240, 400)):
        out[f'Totals: over when the total is {lo}-{hi}'] = total_rule(lambda r, lo=lo, hi=hi: 'over' if lo <= r['close_total'] < hi else None)
        out[f'Totals: under when the total is {lo}-{hi}'] = total_rule(lambda r, lo=lo, hi=hi: 'under' if lo <= r['close_total'] < hi else None)
    out['Totals: over when both teams had 2+ days off'] = total_rule(
        lambda r: 'over' if (r['rest_home'] or 0) >= 3 and (r['rest_away'] or 0) >= 3 else None)
    out['Totals: under when both teams are on a back-to-back'] = total_rule(
        lambda r: 'under' if r['rest_home'] == 1 and r['rest_away'] == 1 else None)
    out['Totals: over when one team is rested and the other tired'] = total_rule(
        lambda r: 'over' if {r['rest_home'], r['rest_away']} & {1} and max(r['rest_home'] or 0, r['rest_away'] or 0) >= 3 else None)
    return out


def team_persistence(rows, cut):
    """Teams' cover rate before the cut vs after it: does covering carry on?"""
    before, after = defaultdict(list), defaultdict(list)
    for r in rows:
        cover = r['margin'] + r['close_home_spread']
        if cover == 0:
            continue
        for team, won in ((r['home'], cover > 0), (r['away'], cover < 0)):
            (before if r['date'] < cut else after)[team].append(won)
    pairs = [(sum(before[t]) / len(before[t]), sum(after[t]) / len(after[t]))
             for t in before if len(before[t]) >= 20 and len(after[t]) >= 10]
    if len(pairs) < 5:
        return None
    xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    corr = cov / math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    # Strategy: back the 8 best covering teams from the first part, in the second part.
    best = sorted(before, key=lambda t: -sum(before[t]) / max(len(before[t]), 1))[:8]
    worst = sorted(before, key=lambda t: sum(before[t]) / max(len(before[t]), 1))[:8]
    def side_bets(teams_, back):
        res = []
        for r in rows:
            if r['date'] < cut:
                continue
            for team, side in ((r['home'], 'home'), (r['away'], 'away')):
                if team in teams_:
                    s = side if back else ('away' if side == 'home' else 'home')
                    b = r2.bet_spread(r['margin'], r['close_home_spread'], s, r[f'close_{s}_spread_odds'])
                    res.append(b)
        return nr.judge(res)
    return {'teams': len(pairs), 'correlation': round(corr, 3), 'back_best_8': side_bets(set(best), True),
            'fade_worst_8': side_bets(set(worst), True)}


def run():
    rows = sorted(r2.joined(lambda *a: None), key=lambda r: r['date'])
    cut = '2026-02-07'
    results = []
    for name, bet in angles().items():
        train = nr.judge([x for r in rows if r['date'] < cut for x in bet(r)])
        test = nr.judge([x for r in rows if r['date'] >= cut for x in bet(r)])
        if not train.get('bets') or not test.get('bets'):
            continue
        both = nr.judge([x for r in rows for x in bet(r)])
        results.append({'rule': name, 'train': train, 'test': test, 'all': both,
                        'edge': bool(train['roi'] > 0 and test['roi'] > 0 and test['bets'] >= 30)})
    results.sort(key=lambda e: e['all']['roi'], reverse=True)
    persistence = team_persistence(rows, cut)
    write(results, persistence, cut)
    return results, persistence


def write(results, persistence, cut):
    def cell(s):
        return f'{s["bets"]} / {s["win_rate"]:.1%} / {s["roi"]:+.1%}' if s.get('bets') else '-'
    section = ['## Round 3: classic angles at the closing price', '',
               f'Fixed buckets, no tuning. Train before {cut}, test after. Moneyline win rates are not comparable '
               'to 52.4%: read the ROI.', '',
               '| Angle | Train: bets / win / ROI | Test: bets / win / ROI | All games ROI | Edge? |', '|---|---|---|---|---|',
               *[f'| {e["rule"]} | {cell(e["train"])} | {cell(e["test"])} | {e["all"]["roi"]:+.1%} | '
                 f'{"**yes**" if e["edge"] else "no"} |' for e in results], '']
    if persistence:
        section += [f'**Do covering teams keep covering?** Correlation between a team\'s cover rate before and after '
                    f'{cut}: {persistence["correlation"]:+.2f} ({persistence["teams"]} teams). Backing the 8 best covering '
                    f'teams afterwards: {cell(persistence["back_best_8"])}; backing the 8 worst: '
                    f'{cell(persistence["fade_worst_8"])}.', '']
    text = VAULT.read_text(encoding='utf-8') if VAULT.exists() else ''
    marker = '## Round 3: classic angles at the closing price'
    VAULT.write_text(text.split(marker)[0].rstrip() + '\n\n' + '\n'.join(section) + '\n', encoding='utf-8')


if __name__ == '__main__':
    results, persistence = run()
    for e in results:
        print(f'{e["rule"]:55s} train {e["train"]["bets"]:4d} {e["train"]["roi"]:+.1%} | test {e["test"]["bets"]:4d} '
              f'{e["test"]["win_rate"]:.1%} {e["test"]["roi"]:+.1%} | all {e["all"]["roi"]:+.1%} {"EDGE" if e["edge"] else ""}')
    print(persistence)
