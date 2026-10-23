"""NBA edge research, round 2: opening vs closing lines.

- Bet the opener: our team models against the opening line, at the opening price
  (realistic if you bet early; openers are the softest lines).
- Closing-line value (CLV): when our model disagrees with the opener, does the line
  move toward our model by the close? A model that "beats the close" holds information
  the market only prices in later - the pros' main sign of a real edge, less noisy
  than results.
- Follow or fade the line's move, betting at the close.
- Moneyline vs spread: DraftKings' closing moneyline against the win chance its own
  closing spread implies.
- League scoring drift: after a run of overs (or unders) league-wide, bet the next total.

Same split as round 1: thresholds chosen on the first 60% of last season, judged on the rest.

Run: python nba_research2.py   (adds a section to "NBA Edge Research.md")
"""
from __future__ import annotations

import json
import math
import statistics
from collections import deque
from datetime import datetime

import nba_extra
import nba_lines
import nba_research as nr

VAULT = nr.VAULT


def joined(log=print) -> list[dict]:
    games = {g['id']: g for g in nba_extra.load_all(log=lambda *a: None)}
    rows = nr.game_rows(list(games.values()))
    by_key = {(g['date'], g['home']): g for g in games.values()}
    out = []
    for r in rows:
        g = by_key.get((r['date'], r['home']))
        if not g:
            continue
        m = nba_lines.moves(g['id'])
        need = ('open_total', 'close_total', 'open_home_spread', 'close_home_spread')
        if not m or any(m.get(k) is None for k in need):
            continue
        out.append({**r, **m})
    return out


def bet_total(points, line, side, odds):
    if points == line:
        return None
    return nr.payout(odds) if (points > line) == (side == 'over') else -1.0


def bet_spread(margin, home_spread, side, odds):
    cover = margin + home_spread
    if cover == 0:
        return None
    return nr.payout(odds) if (cover > 0) == (side == 'home') else -1.0


def strategies(train: list[dict]):
    # Margin spread around the closing spread, from the training games only.
    sd = statistics.pstdev([r['margin'] + r['close_home_spread'] for r in train]) or 12.5

    def open_total_model(r, t):
        gap = r['model_total'] - r['open_total']
        if gap >= t:
            return [bet_total(r['points'], r['open_total'], 'over', r['open_over_odds'])]
        if gap <= -t:
            return [bet_total(r['points'], r['open_total'], 'under', r['open_under_odds'])]
        return []

    def open_spread_model(r, t):
        gap = r['model_margin'] + r['open_home_spread']
        if gap >= t:
            return [bet_spread(r['margin'], r['open_home_spread'], 'home', r['open_home_spread_odds'])]
        if gap <= -t:
            return [bet_spread(r['margin'], r['open_home_spread'], 'away', r['open_away_spread_odds'])]
        return []

    def follow_total_move(r, t):
        move = r['close_total'] - r['open_total']
        side = 'over' if move > 0 else 'under'
        return [bet_total(r['points'], r['close_total'], side, r[f'close_{side}_odds'])] if abs(move) >= t else []

    def fade_total_move(r, t):
        move = r['close_total'] - r['open_total']
        side = 'under' if move > 0 else 'over'
        return [bet_total(r['points'], r['close_total'], side, r[f'close_{side}_odds'])] if abs(move) >= t else []

    def follow_spread_move(r, t):
        move = r['close_home_spread'] - r['open_home_spread']  # Negative: money came on the home side.
        side = 'home' if move < 0 else 'away'
        return [bet_spread(r['margin'], r['close_home_spread'], side, r[f'close_{side}_spread_odds'])] if abs(move) >= t else []

    def fade_spread_move(r, t):
        move = r['close_home_spread'] - r['open_home_spread']
        side = 'away' if move < 0 else 'home'
        return [bet_spread(r['margin'], r['close_home_spread'], side, r[f'close_{side}_spread_odds'])] if abs(move) >= t else []

    def ml_vs_spread(r, t):
        if not r.get('close_home_ml') or not r.get('close_away_ml'):
            return []
        p_spread = 0.5 * (1 + math.erf(-r['close_home_spread'] / (sd * math.sqrt(2))))
        implied = [1 / (1 + nr.payout(r['close_home_ml'])), 1 / (1 + nr.payout(r['close_away_ml']))]
        p_ml = implied[0] / sum(implied)
        out = []
        if p_spread - p_ml >= t:  # The moneyline undervalues home vs the spread.
            out.append(1 * nr.payout(r['close_home_ml']) if r['margin'] > 0 else -1.0)
        elif p_ml - p_spread >= t:
            out.append(1 * nr.payout(r['close_away_ml']) if r['margin'] < 0 else -1.0)
        return out

    return {
        'Bet the opener: totals model vs the opening total': (open_total_model, [2, 4, 6, 8]),
        'Bet the opener: spread model vs the opening spread': (open_spread_model, [2, 3, 4, 6]),
        'Follow the total\'s move (bet at the close)': (follow_total_move, [1, 2, 3, 4]),
        'Fade the total\'s move (bet at the close)': (fade_total_move, [1, 2, 3, 4]),
        'Follow the spread\'s move (bet at the close)': (follow_spread_move, [0.5, 1, 1.5, 2]),
        'Fade the spread\'s move (bet at the close)': (fade_spread_move, [0.5, 1, 1.5, 2]),
        'Moneyline vs DraftKings\' own spread': (ml_vs_spread, [0.02, 0.03, 0.05]),
    }


def scoring_drift(rows: list[dict], cut: str) -> list[dict]:
    """After the last N totals league-wide went over (or under) at a rate past a cut, bet the
    next one each way: momentum (same way) and reversion (the other way)."""
    out = []
    for n in (30, 60):
        for rate in (0.55, 0.6):
            for mode in ('momentum', 'reversion'):
                window, train, test = deque(maxlen=n), [], []
                for r in sorted(rows, key=lambda r: r['date']):
                    if len(window) == n:
                        over_rate = sum(window) / n
                        side = None
                        if over_rate >= rate:
                            side = 'over' if mode == 'momentum' else 'under'
                        elif over_rate <= 1 - rate:
                            side = 'under' if mode == 'momentum' else 'over'
                        if side:
                            result = bet_total(r['points'], r['close_total'], side, r[f'close_{side}_odds'])
                            (train if r['date'] < cut else test).append(result)
                    if r['points'] != r['close_total']:
                        window.append(1 if r['points'] > r['close_total'] else 0)
                out.append({'rule': f'League totals {mode}: last {n} games {rate:.0%}+ one way', 'threshold': f'{n}/{rate}',
                            'train': nr.judge(train), 'test': nr.judge(test)})
    for e in out:
        e['edge'] = bool(e['train'].get('roi', -1) > 0 and e['test'].get('roi', -1) > 0 and e['test'].get('bets', 0) >= 30)
    return out


def clv(rows: list[dict], cut: str) -> list[dict]:
    """When the model disagrees with the opener, how often does the line move its way by the
    close? 50% = no information. Counted on the unseen games."""
    out = []
    for name, model_key, open_key, close_key, sign in (
            ('Totals model', 'model_total', 'open_total', 'close_total', 1),
            ('Spread model', 'model_margin', 'open_home_spread', 'close_home_spread', -1)):
        for t in ((2, 4, 6) if name == 'Totals model' else (1, 2, 4)):
            toward = moved = 0
            for r in rows:
                if r['date'] < cut:
                    continue
                model_line = r[model_key] if sign == 1 else -r[model_key]  # Spread in home-spread terms.
                gap = model_line - r[open_key]
                move = r[close_key] - r[open_key]
                if abs(gap) < t or move == 0:
                    continue
                moved += 1
                toward += (move > 0) == (gap > 0)
            out.append({'model': name, 'disagreement': t, 'games_that_moved': moved,
                        'moved_toward_model': round(toward / moved, 3) if moved else None})
    return out


def run(log=print) -> dict:
    rows = joined(log)
    rows.sort(key=lambda r: r['date'])
    last_season = [r for r in rows if r['date'] < '2026-10-01']
    cut = last_season[int(len(last_season) * nr.SPLIT)]['date']
    train = [r for r in rows if r['date'] < cut]
    test = [r for r in rows if r['date'] >= cut]
    results = []
    for name, (rule, thresholds) in strategies(train).items():
        tried = [(nr.judge([x for r in train for x in rule(r, t)]), t) for t in thresholds]
        tried = [(a, t) for a, t in tried if a.get('bets', 0) >= 40]
        if not tried:
            results.append({'rule': name, 'note': 'too few bets'})
            continue
        a, t = max(tried, key=lambda p: p[0]['roi'])
        b = nr.judge([x for r in test for x in rule(r, t)])
        results.append({'rule': name, 'threshold': t, 'train': a, 'test': b,
                        'edge': bool(a['roi'] > 0 and b.get('roi', -1) > 0 and b.get('bets', 0) >= 30)})
    results += scoring_drift(rows, cut)
    results.sort(key=lambda e: e.get('test', {}).get('roi', -9), reverse=True)
    value = clv(rows, cut)
    write(results, value, cut, len(rows))
    return {'results': results, 'clv': value, 'games': len(rows), 'cut': cut}


def write(results, value, cut, n):
    def cell(s):
        return f'{s["bets"]} / {s["win_rate"]:.1%} / {s["roi"]:+.1%}' if s.get('bets') else '-'
    section = ['## Round 2: opening vs closing lines', '',
               f'{n} games with DraftKings\' (or ESPN BET\'s) opening and closing lines. Thresholds chosen before {cut}; '
               'judged after.', '',
               '| Rule | Threshold | Train: bets / win rate / ROI | Test (unseen): bets / win rate / ROI | Edge? |', '|---|---|---|---|---|',
               *[f'| {e["rule"]} | {e.get("threshold", "-")} | {cell(e.get("train", {}))} | {cell(e.get("test", {}))} | '
                 f'{"**yes**" if e.get("edge") else "no"} |' for e in results], '',
               '### Does the line move toward our models? (closing-line value, unseen games)', '',
               '50% means the model knows nothing the market does not; well above 50% would be a real edge.', '',
               '| Model | Disagreement with the opener | Games whose line moved | Moved toward the model |', '|---|---|---|---|',
               *[f'| {v["model"]} | {v["disagreement"]}+ | {v["games_that_moved"]} | '
                 f'{v["moved_toward_model"]:.1%} |' if v['moved_toward_model'] is not None else
                 f'| {v["model"]} | {v["disagreement"]}+ | 0 | - |' for v in value], '']
    text = VAULT.read_text(encoding='utf-8') if VAULT.exists() else ''
    marker = '## Round 2: opening vs closing lines'
    text = text.split(marker)[0].rstrip() + '\n\n' + '\n'.join(section) + '\n'
    VAULT.write_text(text, encoding='utf-8')


if __name__ == '__main__':
    out = run()
    print(out['games'], 'games, cut', out['cut'])
    for e in out['results']:
        print(e['rule'], e.get('threshold'), e.get('train'), e.get('test'), 'EDGE' if e.get('edge') else '')
    for v in out['clv']:
        print(v)
