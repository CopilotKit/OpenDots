"""NBA edge research: many ideas, each judged on games it was not chosen on.

A. Game lines against DraftKings' real prices (ESPN's pick center, every game):
   totals and spreads bet at the listed odds, so a rule must win more than the juice
   (about 52.4% at -110) on the held-out games to count as an edge.
B. Player points: features that might predict points better than our projection
   (shots, teammates out, rest, blowout risk, game total, pace), judged by error on
   held-out games.

Walk-forward throughout: every feature uses only earlier games; each rule's threshold
is chosen on the first 60% of last season ("train") and judged on the rest plus this
season ("test").

Run: python nba_research.py   (writes "NBA Edge Research.md" to the vault)
"""
from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict, deque
from datetime import date, datetime
from pathlib import Path

import numpy as np

import nba_data
import nba_extra
import nba_props as nb

VAULT = Path('C:/Users/inter/Desktop/MainAINotes/Site Maps/DraftKings/NBA Edge Research.md')
RESULTS = Path(__file__).resolve().parent.parent / 'data' / 'nba-research.json'
SPLIT = 0.6


def payout(odds: float | None) -> float:
    """Profit per $1 staked at American odds (default -110)."""
    odds = odds or -110
    return 100 / abs(odds) if odds < 0 else odds / 100


# Team form, walk-forward -------------------------------------------------------------
def possessions(t: dict) -> float:
    return t['fga'] - t['oreb'] + t['tov'] + 0.44 * t['fta']


class Teams:
    """Rolling per-team pace and per-possession scoring, before each game."""

    def __init__(self, window: int = 15):
        self.games = defaultdict(lambda: deque(maxlen=window))  # team -> (pace, off_rtg, def_rtg, margin)
        self.last_day = {}
        self.ats = defaultdict(lambda: deque(maxlen=5))  # team -> covered last games (1/0)

    def form(self, team: str, decay: float = 1.0):
        """Recent-game averages; decay < 1 weights the latest games more (0.93: each game back counts 7% less)."""
        g = list(self.games[team])
        if len(g) < 5:
            return None
        w = [decay ** (len(g) - 1 - k) for k in range(len(g))]
        avg = lambda i: sum(wk * x[i] for wk, x in zip(w, g)) / sum(w)
        return {'pace': avg(0), 'off': avg(1), 'def': avg(2), 'net': avg(3)}

    def rest(self, team: str, day: str) -> int | None:
        last = self.last_day.get(team)
        return (date.fromisoformat(day) - date.fromisoformat(last)).days if last else None

    def update(self, g: dict):
        h, a = g['teams'].get('home'), g['teams'].get('away')
        if not h or not a:
            return
        pace = (possessions(h) + possessions(a)) / 2
        if pace <= 0:
            return
        hs, as_ = g['score']['home'], g['score']['away']
        self.games[g['home']].append((pace, 100 * hs / pace, 100 * as_ / pace, hs - as_))
        self.games[g['away']].append((pace, 100 * as_ / pace, 100 * hs / pace, as_ - hs))
        self.last_day[g['home']] = self.last_day[g['away']] = g['date']
        spread = g['line'].get('home_spread')
        if spread is not None and hs - as_ + spread != 0:
            home_cover = 1 if hs - as_ + spread > 0 else 0
            self.ats[g['home']].append(home_cover)
            self.ats[g['away']].append(1 - home_cover)


def game_rows(games: list[dict]) -> list[dict]:
    """Per game: the line, the result, and pre-game features (from earlier games only)."""
    teams = Teams()
    rows = []
    league_pace = deque(maxlen=300)
    for g in sorted(games, key=lambda g: g['date']):
        line = g['line']
        fh, fa = teams.form(g['home']), teams.form(g['away'])
        if line.get('total') and line.get('home_spread') is not None and fh and fa and league_pace:
            lp = statistics.mean(league_pace)
            pace = fh['pace'] * fa['pace'] / lp
            # Expected points: own offence against their defence, around the league level.
            league_rtg = statistics.mean(x for t in teams.games.values() for p in t for x in (p[1],)) if teams.games else 110
            home_pts = pace * (fh['off'] + fa['def'] - league_rtg) / 100
            away_pts = pace * (fa['off'] + fh['def'] - league_rtg) / 100
            rows.append({
                'date': g['date'], 'home': g['home'], 'away': g['away'], 'total': line['total'],
                'home_spread': line['home_spread'], 'over_odds': line.get('over_odds'), 'under_odds': line.get('under_odds'),
                'home_spread_odds': line.get('home_spread_odds'), 'away_spread_odds': line.get('away_spread_odds'),
                'home_ml': line.get('home_ml'), 'away_ml': line.get('away_ml'),
                'points': g['score']['home'] + g['score']['away'], 'margin': g['score']['home'] - g['score']['away'],
                'model_total': home_pts + away_pts, 'model_margin': home_pts - away_pts + 2.5,  # Home court.
                'pace': pace, 'net_gap': fh['net'] - fa['net'],
                'rest_home': teams.rest(g['home'], g['date']), 'rest_away': teams.rest(g['away'], g['date']),
                'ats_home': sum(teams.ats[g['home']]) if len(teams.ats[g['home']]) == 5 else None,
                'ats_away': sum(teams.ats[g['away']]) if len(teams.ats[g['away']]) == 5 else None})
        teams.update(g)
        h, a = g['teams'].get('home'), g['teams'].get('away')
        if h and a:
            league_pace.append((possessions(h) + possessions(a)) / 2)
    return rows


# Bets ------------------------------------------------------------------------------
def total_bet(r, side):  # side 'over' / 'under' -> profit per $1, None for a push.
    if r['points'] == r['total']:
        return None
    won = (r['points'] > r['total']) == (side == 'over')
    return payout(r['over_odds'] if side == 'over' else r['under_odds']) if won else -1.0


def spread_bet(r, side):  # side 'home' / 'away'
    cover = r['margin'] + r['home_spread']
    if cover == 0:
        return None
    won = (cover > 0) == (side == 'home')
    return payout(r['home_spread_odds'] if side == 'home' else r['away_spread_odds']) if won else -1.0


def ml_bet(r, side):
    won = (r['margin'] > 0) == (side == 'home')
    return payout(r['home_ml'] if side == 'home' else r['away_ml']) if won else -1.0


def judge(results: list[float | None]) -> dict:
    played = [x for x in results if x is not None]
    if not played:
        return {'bets': 0}
    wins = sum(x > 0 for x in played)
    return {'bets': len(played), 'win_rate': round(wins / len(played), 3), 'roi': round(sum(played) / len(played), 4),
            'profit_per_100': round(sum(played) * 100 / len(played), 2)}


def rules(rows: list[dict]) -> dict:
    """Each rule: f(row, threshold) -> list of bets (each a profit or None); thresholds to try."""
    def model_total(r, t):
        gap = r['model_total'] - r['total']
        return [total_bet(r, 'over')] if gap >= t else [total_bet(r, 'under')] if gap <= -t else []

    def model_spread(r, t):
        gap = r['model_margin'] + r['home_spread']  # >0: model thinks home covers.
        return [spread_bet(r, 'home')] if gap >= t else [spread_bet(r, 'away')] if gap <= -t else []

    def back_to_back_under(r, t):
        tired = (r['rest_home'] == 1) + (r['rest_away'] == 1)
        return [total_bet(r, 'under')] if tired >= t else []

    def fade_tired_team(r, t):
        if r['rest_home'] == 1 and (r['rest_away'] or 0) >= t:
            return [spread_bet(r, 'away')]
        if r['rest_away'] == 1 and (r['rest_home'] or 0) >= t:
            return [spread_bet(r, 'home')]
        return []

    def big_favorite_under(r, t):
        return [total_bet(r, 'under')] if abs(r['home_spread']) >= t else []

    def big_dog_cover(r, t):
        if abs(r['home_spread']) < t:
            return []
        return [spread_bet(r, 'away' if r['home_spread'] < 0 else 'home')]

    def fade_hot_ats(r, t):
        out = []
        if r['ats_home'] is not None and r['ats_home'] >= t:
            out.append(spread_bet(r, 'away'))
        if r['ats_away'] is not None and r['ats_away'] >= t:
            out.append(spread_bet(r, 'home'))
        return out

    def underdog_value(r, t):
        # Model win chance from its margin (NBA margins: sd about 12.5) vs the dog's price.
        p_home = 0.5 * (1 + math.erf(r['model_margin'] / (12.5 * math.sqrt(2))))
        out = []
        for side, p, ml in (('home', p_home, r['home_ml']), ('away', 1 - p_home, r['away_ml'])):
            if ml and ml > 0 and p * (1 + payout(ml)) - 1 >= t:
                out.append(ml_bet(r, side))
        return out

    def fast_pace_over(r, t):
        return [total_bet(r, 'over')] if r['pace'] >= t else []

    paces = sorted(r['pace'] for r in rows)
    pace_cuts = [paces[int(len(paces) * q)] for q in (0.7, 0.8, 0.9)] if paces else []
    return {
        'Totals: pace x efficiency model vs the line': (model_total, [2, 4, 6, 8, 10]),
        'Spreads: team-rating model vs the line': (model_spread, [2, 3, 4, 6, 8]),
        'Totals: under when teams are on a back-to-back': (back_to_back_under, [1, 2]),
        'Spreads: fade a back-to-back team against a rested one': (fade_tired_team, [1, 2, 3]),
        'Totals: under when the spread is big (blowout)': (big_favorite_under, [8, 10, 12, 14]),
        'Spreads: big underdogs cover': (big_dog_cover, [8, 10, 12, 14]),
        'Spreads: fade teams that covered 4-5 of their last 5': (fade_hot_ats, [4, 5]),
        'Moneyline: underdogs the model rates higher': (underdog_value, [0.02, 0.05, 0.10, 0.15]),
        'Totals: over in the fastest-paced matchups': (fast_pace_over, pace_cuts),
    }


def test_games(rows: list[dict]) -> list[dict]:
    rows = sorted(rows, key=lambda r: r['date'])
    last_season = [r for r in rows if r['date'] < nb.season_start(rows[-1]['date'])] or rows
    cut = last_season[int(len(last_season) * SPLIT)]['date']
    out = []
    for name, (rule, thresholds) in rules(rows).items():
        train = [r for r in rows if r['date'] < cut]
        test = [r for r in rows if r['date'] >= cut]
        tried = []
        for t in thresholds:
            a = judge([x for r in train for x in rule(r, t)])
            if a['bets'] >= 40:
                tried.append((a['roi'], t, a))
        if not tried:
            out.append({'rule': name, 'note': 'too few bets'})
            continue
        roi, t, a = max(tried)
        b = judge([x for r in test for x in rule(r, t)])
        out.append({'rule': name, 'threshold': t, 'train': a, 'test': b,
                    'edge': bool(a['roi'] > 0 and b.get('roi', -1) > 0 and b.get('bets', 0) >= 30)})
    out.sort(key=lambda e: e.get('test', {}).get('roi', -9), reverse=True)
    return out, cut


# B. Player points --------------------------------------------------------------------
def player_rows(box_rows: list[dict], games: dict[str, dict]) -> list[dict]:
    """Per player game: the projection, extra features (earlier games only) and the points."""
    h = nb.History(box_rows)
    by_game_team = defaultdict(list)
    for r in box_rows:
        by_game_team[(r['game'], r['team'])].append(r)
    team_games = defaultdict(list)  # team -> [(date, game)]
    for (game, team), rs in by_game_team.items():
        team_games[team].append((rs[0]['date'], game))
    for v in team_games.values():
        v.sort()
    team_days = {t: [d for d, _ in v] for t, v in team_games.items()}
    out = []
    for r in box_rows:
        if r['date'] < '2025-11-15' or r['min'] < 10:
            continue
        before = h.player_before(r['player'], r['date'])
        p = nb.projection(before, h.opponent_factor(r['opponent'], r['date']))
        if not p or p['minutes'] < 15:
            continue
        recent = before[-25:]
        shots = sum(g['fga'] + 0.44 * g['fta'] for g in recent[-10:]) / len(recent[-10:])
        season = [g for g in before if g['date'] >= nb.season_start(r['date'])] or recent
        per_shot = sum(g['pts'] for g in season) / max(sum(g['fga'] + 0.44 * g['fta'] for g in season), 1)
        # Teammates out: rotation players (20+ minutes in the team's last 10 games) who did not play.
        prior = [g for d, g in team_games[r['team']] if d < r['date']][-10:]
        minutes = defaultdict(list)
        usage = defaultdict(list)
        for gid in prior:
            for t in by_game_team[(gid, r['team'])]:
                minutes[t['player']].append(t['min'])
                usage[t['player']].append(t['fga'] + 0.44 * t['fta'])
        tonight = {t['player'] for t in by_game_team[(r['game'], r['team'])]}
        rotation = [n for n, m in minutes.items() if len(m) >= 5 and statistics.mean(m) >= 20 and n != r['player']]
        vacated = sum(statistics.mean(usage[n]) for n in rotation if n not in tonight)
        days = team_days[r['team']]
        k = days.index(r['date']) if r['date'] in days else 0
        b2b = 1.0 if k and (date.fromisoformat(r['date']) - date.fromisoformat(days[k - 1])).days == 1 else 0.0
        g = games.get(r['game'])
        line = (g or {}).get('line', {})
        spread = line.get('home_spread')
        own_spread = (spread if r['home'] else -spread) if spread is not None else None
        out.append({'date': r['date'], 'pts': r['pts'], 'base': p['mean'], 'shot_based': p['minutes'] / max(p['minutes'], 1) * shots * per_shot,
                    'vacated': vacated, 'b2b': b2b, 'abs_spread': abs(own_spread) if own_spread is not None else 0.0,
                    'favored_big': 1.0 if own_spread is not None and own_spread <= -10 else 0.0,
                    'total': line.get('total') or 0.0, 'has_line': 1.0 if line.get('total') else 0.0})
    return out


def test_players(rows: list[dict]) -> list[dict]:
    rows = [r for r in rows if r['has_line']]
    cut = '2026-02-01'
    train = [r for r in rows if r['date'] < cut]
    test = [r for r in rows if r['date'] >= cut]
    mean_total = statistics.mean(r['total'] for r in train)
    def design(r, names):
        cols = {'base': r['base'], 'shot_based': r['shot_based'], 'vacated': r['vacated'] * r['base'] / 15,
                'b2b': r['b2b'] * r['base'], 'blowout': r['abs_spread'] * r['base'] / 10,
                'favored_big': r['favored_big'] * r['base'], 'total': (r['total'] - mean_total) * r['base'] / 220}
        return [cols[n] for n in names]
    variants = {
        'Current projection': ['base'],
        '+ shot volume x efficiency': ['base', 'shot_based'],
        '+ teammates out (vacated shots)': ['base', 'vacated'],
        '+ back-to-back': ['base', 'b2b'],
        '+ blowout risk (spread)': ['base', 'blowout', 'favored_big'],
        '+ game total': ['base', 'total'],
        'All of them': ['base', 'shot_based', 'vacated', 'b2b', 'blowout', 'favored_big', 'total'],
    }
    out = []
    base_mae = None
    for name, names in variants.items():
        X = np.array([design(r, names) + [1.0] for r in train])
        y = np.array([r['pts'] for r in train])
        coef = np.linalg.lstsq(X, y, rcond=None)[0]
        pred = np.array([design(r, names) + [1.0] for r in test]) @ coef
        actual = np.array([r['pts'] for r in test])
        mae = float(np.mean(np.abs(pred - actual)))
        base_mae = base_mae or mae
        out.append({'variant': name, 'mae': round(mae, 3), 'improvement': round(base_mae - mae, 3),
                    'weights': {n: round(float(c), 3) for n, c in zip(names + ['intercept'], coef)}})
    return out, len(train), len(test)


def report(game_tests, cut, players, n_train, n_test) -> str:
    def cell(s):
        return f'{s["bets"]} / {s["win_rate"]:.1%} / {s["roi"]:+.1%}' if s.get('bets') else '-'
    lines = ['---', 'tags:', '  - "sports"', '  - "nba"', '  - "edge-research"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# NBA Edge Research', '',
             '## A. Game lines against DraftKings\' real prices', '',
             f'DraftKings\' spread, total and moneyline for every game (ESPN pick center). Each rule\'s threshold was '
             f'chosen on games before {cut}; the test is every game from {cut} on, which it never saw. Bets at the '
             'listed odds: at -110 a rule needs 52.4% to break even.', '',
             '| Rule | Threshold | Train: bets / win rate / ROI | Test (unseen): bets / win rate / ROI | Edge? |', '|---|---|---|---|---|',
             *[f'| {e["rule"]} | {e.get("threshold", "-")} | {cell(e.get("train", {}))} | {cell(e.get("test", {}))} | '
               f'{"**yes**" if e.get("edge") else "no"} |' for e in game_tests], '',
             '## B. Player points: does a stat predict better than our projection?', '',
             f'Fitted on {n_train:,} player games (Nov-Jan of last season), judged on {n_test:,} (Feb-Apr). Error = average '
             'miss in points; "better" = how much it shrinks that error vs the current projection.', '',
             '| Variant | Average miss (pts) | Better by | Weights |', '|---|---|---|---|',
             *[f'| {p["variant"]} | {p["mae"]:.3f} | {p["improvement"]:+.3f} | {p["weights"]} |' for p in players], '']
    return '\n'.join(lines) + '\n'


def run(log=print) -> dict:
    games = nba_extra.load_all(log=log)
    rows = game_rows(games)
    game_tests, cut = test_games(rows)
    log(f'{len(rows)} games with lines tested')
    box_rows = nba_data.load(log=lambda *a: None)
    players, n_train, n_test = test_players(player_rows(box_rows, {g['id']: g for g in games}))
    RESULTS.write_text(json.dumps({'games': game_tests, 'cut': cut, 'players': players}, indent=1, default=str))
    VAULT.parent.mkdir(parents=True, exist_ok=True)
    VAULT.write_text(report(game_tests, cut, players, n_train, n_test), encoding='utf-8')
    return {'games': game_tests, 'players': players}


if __name__ == '__main__':
    result = run()
    for e in result['games']:
        print(e.get('rule'), e.get('threshold'), e.get('train'), e.get('test'), 'EDGE' if e.get('edge') else '')
    for p in result['players']:
        print(p['variant'], p['mae'], p['improvement'])
