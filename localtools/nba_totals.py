"""NBA totals: our pace x efficiency model against DraftKings' early totals (paper).

Edge research (Site Maps/DraftKings/NBA Edge Research.md, 2026-10-23): when the model's
total disagreed with DraftKings' OPENING total by 4+ points, betting the model's side at
the opener won ~58% on unseen games (+10% a bet), even with the model blind to the
previous day; and the line then moved toward the model by the close 60-70% of the time.
At the closing line the same bets lost: the edge is early. So the test is live:

- scan (mornings): today's DraftKings totals now (The Odds API, 1 credit), the model's
  totals (team pace and points per possession over the last 15 games, ESPN), and a paper
  bet wherever they differ by MIN_GAP+;
- settle (next morning): the final score and DraftKings' closing total (ESPN), so each
  bet records its result AND whether the line moved our way (closing-line value).

Run: python nba_totals.py scan | settle | status
"""
from __future__ import annotations

import json
import sqlite3
import statistics
import time
import uuid
from collections import deque
from contextlib import closing
from datetime import date, datetime, timedelta, timezone

import nba_data
import nba_extra
import nba_lines
import nba_props as nb
import nba_research as nr
import sports_picks as sp

MIN_GAP = 4.0
STAKE = 10.0


def model_now(today: date, log=lambda *a: None) -> tuple[nr.Teams, float, float]:
    """Team form from every finished game before today."""
    games = [g for g in nba_extra.load_all(log=log) if g['date'] < today.isoformat()]
    teams, paces = nr.Teams(), deque(maxlen=300)
    for g in sorted(games, key=lambda g: g['date']):
        teams.update(g)
        h, a = g['teams'].get('home'), g['teams'].get('away')
        if h and a:
            paces.append((nr.possessions(h) + nr.possessions(a)) / 2)
    league_rtg = statistics.mean(p[1] for t in teams.games.values() for p in t) if teams.games else 110.0
    return teams, (statistics.mean(paces) if paces else 100.0), league_rtg


def model_total(teams: nr.Teams, league_pace: float, league_rtg: float, home: str, away: str) -> float | None:
    names = {nb.nickname(t): t for t in teams.games}
    fh, fa = teams.form(names.get(nb.nickname(home), home)), teams.form(names.get(nb.nickname(away), away))
    if not fh or not fa:
        return None
    pace = fh['pace'] * fa['pace'] / league_pace
    return pace * (fh['off'] + fa['def'] - league_rtg) / 100 + pace * (fa['off'] + fh['def'] - league_rtg) / 100


class Bets:
    def __init__(self, path=sp.DB):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS nba_totals(id TEXT PRIMARY KEY, ts REAL, day TEXT, event TEXT, home TEXT, '
                       'away TEXT, start TEXT, side TEXT, line REAL, odds REAL, model REAL, gap REAL, '
                       'close_line REAL, points REAL, result TEXT, profit REAL, clv REAL)')

    def rows(self, where='1=1', args=()):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(f'SELECT * FROM nba_totals WHERE {where} ORDER BY ts', args)]

    def add(self, bet: dict) -> bool:
        if self.rows('event=?', (bet['event'],)):
            return False  # One bet per game: the first (earliest) line counts.
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO nba_totals(id, ts, day, event, home, away, start, side, line, odds, model, gap) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (uuid.uuid4().hex[:8], time.time(), bet['day'], bet['event'], bet['home'], bet['away'], bet['start'],
                        bet['side'], bet['line'], bet['odds'], bet['model'], bet['gap']))
        return True

    def close(self, identity: str, **fields) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(f'UPDATE nba_totals SET {", ".join(f"{k}=?" for k in fields)} WHERE id=?', (*fields.values(), identity))

    def summary(self) -> dict:
        done = self.rows("result IN ('won', 'lost')")
        clv = [r['clv'] for r in self.rows('clv IS NOT NULL')]
        return {'bets': len(done), 'open': len(self.rows('result IS NULL')),
                'win_rate': round(sum(r['result'] == 'won' for r in done) / len(done), 3) if done else None,
                'profit': round(sum(r['profit'] for r in done), 2), 'roi': round(sum(r['profit'] for r in done) / (STAKE * len(done)), 3) if done else None,
                'line_moved_our_way': round(sum(c > 0 for c in clv) / sum(c != 0 for c in clv), 3) if any(c != 0 for c in clv) else None,
                'avg_clv_points': round(statistics.mean(clv), 2) if clv else None}


def scan(bets: Bets | None = None, http=None, say=None, now: datetime | None = None) -> dict:
    bets = bets or Bets()
    now = now or datetime.now(timezone.utc)
    today = datetime.strptime(nb.eastern_day(now.strftime('%Y-%m-%dT%H:%M:%SZ')), '%Y-%m-%d').date()
    events = sp.get('/sports/basketball_nba/odds', {'bookmakers': 'draftkings', 'markets': 'totals', 'oddsFormat': 'american'}, 1, http)
    teams, league_pace, league_rtg = model_now(today)
    placed, looked = [], 0
    for e in events:
        start = datetime.fromisoformat(e['commence_time'].replace('Z', '+00:00'))
        if not now + timedelta(minutes=15) <= start <= now + timedelta(hours=30):
            continue
        market = next((m for b in e.get('bookmakers', []) if b['key'] == 'draftkings' for m in b['markets'] if m['key'] == 'totals'), None)
        if not market:
            continue
        prices = {o['name'].lower(): o for o in market['outcomes']}
        if 'over' not in prices or 'under' not in prices:
            continue
        line = prices['over']['point']
        looked += 1
        m = model_total(teams, league_pace, league_rtg, e['home_team'], e['away_team'])
        if m is None or abs(m - line) < MIN_GAP:
            continue
        side = 'over' if m > line else 'under'
        bet = {'day': nb.eastern_day(e['commence_time']), 'event': e['id'], 'home': e['home_team'], 'away': e['away_team'],
               'start': e['commence_time'], 'side': side, 'line': line, 'odds': prices[side]['price'], 'model': round(m, 1),
               'gap': round(m - line, 1)}
        if bets.add(bet):
            placed.append(bet)
    if say and placed:
        say({'at': time.time(), 'trade': f'nba-totals-{today}', 'event': 'nba totals',
             'title': f'{len(placed)} paper NBA total{"s" if len(placed) != 1 else ""} (early line)',
             'message': ' | '.join(f'{b["side"]} {b["line"]:g} ({b["away"]} at {b["home"]}), model {b["model"]:g}, {b["odds"]:+g}'
                                   for b in placed)})
    return {'games_priced': looked, 'placed': placed, 'credits_left': sp.credits_left(), **bets.summary()}


def settle(bets: Bets | None = None, today: date | None = None) -> dict:
    """Final scores and DraftKings' closing totals from ESPN for yesterday's and older bets."""
    bets = bets or Bets()
    today = today or date.today()
    settled = 0
    for b in bets.rows('result IS NULL'):
        day = date.fromisoformat(b['day'])
        if day >= today:
            continue
        game = next((g for g in nba_data.games_on(day) if {nb.nickname(g['home']), nb.nickname(g['away'])}
                     == {nb.nickname(b['home']), nb.nickname(b['away'])}), None)
        if not game or not game['final']:
            continue
        info = nba_extra.extra(game['id'])
        points = info['score']['home'] + info['score']['away']
        close_line = (nba_lines.moves(game['id']) or {}).get('close_total')
        if points == b['line']:
            result, profit = 'push', 0.0
        else:
            won = (points > b['line']) == (b['side'] == 'over')
            result, profit = ('won', round(STAKE * nr.payout(b['odds']), 2)) if won else ('lost', -STAKE)
        # Closing-line value in points: how far the line moved our way after we bet.
        clv = None if close_line is None else round((close_line - b['line']) * (1 if b['side'] == 'over' else -1), 1)
        bets.close(b['id'], close_line=close_line, points=points, result=result, profit=profit, clv=clv)
        settled += 1
    return {'settled': settled, **bets.summary()}


if __name__ == '__main__':
    import sys
    command = (sys.argv[1:] or ['status'])[0]
    if command == 'scan':
        import options_watch
        print(json.dumps(scan(say=options_watch.notify), indent=1, default=str))
    elif command == 'settle':
        print(json.dumps(settle(), indent=1))
    else:
        print(json.dumps(Bets().summary(), indent=1))
