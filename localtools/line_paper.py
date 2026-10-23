"""Live paper tests of the two other leads from the edge research (2026-10-23):

- NFL spreads: the team-scoring model against DraftKings' early spread. On unseen games
  it won ~59-63% (+12-20% a bet) in late 2025 and weeks 1-7 of 2026, but once blind to
  the previous week the line no longer moved toward it - promising, unproven.
- NHL puck line: the model's side of the +-1.5 line. Unseen games +7.6% a bet where
  backing every +1.5 side lost 1.1%; line moves cannot be read on a +-1.5 line.

scan: DraftKings' current spreads (The Odds API, 1 credit) vs the model built from
every finished game so far (ESPN), a paper bet where they differ by the rule's
threshold, once per game. settle: final scores from ESPN.

Run: python line_paper.py scan NFL | scan NHL | settle | status
"""
from __future__ import annotations

import json
import sqlite3
import statistics
import time
import uuid
from collections import defaultdict, deque
from contextlib import closing
from datetime import date, datetime, timedelta, timezone

import nba_props as nb
import nba_research as nr
import sport_lines as sl
import sports_picks as sp

STAKE = 10.0
RULES = {
    # history key in sport_lines, Odds API key, training season (for the home edge), window, threshold
    'NFL': {'history': 'NFL+2026', 'odds': 'americanfootball_nfl', 'train': ('2025-09-04', '2025-11-30'), 'window': 6,
            'threshold': 5.24, 'lookahead_days': 8},
    'NHL': {'history': 'NHL+2026', 'odds': 'icehockey_nhl', 'train': ('2025-10-07', '2026-01-25'), 'window': 15,
            'threshold': 0.92, 'lookahead_days': 1.2},
}
sl.SPORTS.setdefault('NHL+2026', ('hockey', 'nhl', '2025-10-07', '2026-10-20', 15))


def form_model(sport: str, today: date) -> tuple[dict, float, float]:
    """Each team's recent points for and against, the league average and the home edge."""
    rule = RULES[sport]
    finished = sorted(sl.games(rule['history'], end=(today - timedelta(days=1)).isoformat()), key=lambda g: g['date'])
    form = defaultdict(lambda: deque(maxlen=rule['window']))
    league = deque(maxlen=rule['window'] * 30)
    edges = []
    start, cut = rule['train']
    for g in finished:
        fh, fa = form[g['home']], form[g['away']]
        if start <= g['date'] < cut and len(fh) >= 3 and len(fa) >= 3 and league:
            avg = statistics.mean(league)
            exp = lambda f, o: statistics.mean(x[0] for x in f) * statistics.mean(x[1] for x in o) / avg
            edges.append((g['home_pts'] - g['away_pts']) - (exp(fh, fa) - exp(fa, fh)))
        form[g['home']].append((g['home_pts'], g['away_pts']))
        form[g['away']].append((g['away_pts'], g['home_pts']))
        league.extend([g['home_pts'], g['away_pts']])
    return form, (statistics.mean(league) if league else 1.0), (statistics.mean(edges) if edges else 0.0)


def model_margin(form, avg, edge, home, away) -> float | None:
    names = {nb.nickname(t): t for t in form}
    fh, fa = form.get(names.get(nb.nickname(home), home)), form.get(names.get(nb.nickname(away), away))
    if not fh or not fa or len(fh) < 3 or len(fa) < 3:
        return None
    exp = lambda f, o: statistics.mean(x[0] for x in f) * statistics.mean(x[1] for x in o) / avg
    return exp(fh, fa) - exp(fa, fh) + edge


class Bets:
    def __init__(self, path=sp.DB):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS line_paper(id TEXT PRIMARY KEY, ts REAL, sport TEXT, day TEXT, event TEXT, '
                       'home TEXT, away TEXT, start TEXT, side TEXT, home_spread REAL, odds REAL, model REAL, '
                       'result TEXT, profit REAL)')

    def rows(self, where='1=1', args=()):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(f'SELECT * FROM line_paper WHERE {where} ORDER BY ts', args)]

    def add(self, bet: dict) -> bool:
        if self.rows('event=?', (bet['event'],)):
            return False
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO line_paper(id, ts, sport, day, event, home, away, start, side, home_spread, odds, model) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (uuid.uuid4().hex[:8], time.time(), bet['sport'], bet['day'], bet['event'], bet['home'], bet['away'],
                        bet['start'], bet['side'], bet['home_spread'], bet['odds'], bet['model']))
        return True

    def summary(self) -> dict:
        out = {}
        for sport in RULES:
            done = self.rows("sport=? AND result IN ('won', 'lost')", (sport,))
            out[sport] = {'bets': len(done), 'open': len(self.rows('sport=? AND result IS NULL', (sport,))),
                          'win_rate': round(sum(r['result'] == 'won' for r in done) / len(done), 3) if done else None,
                          'profit': round(sum(r['profit'] for r in done), 2)}
        return out


def scan(sport: str, bets: Bets | None = None, http=None, say=None, now: datetime | None = None) -> dict:
    bets = bets or Bets()
    rule = RULES[sport]
    now = now or datetime.now(timezone.utc)
    today = datetime.strptime(nb.eastern_day(now.strftime('%Y-%m-%dT%H:%M:%SZ')), '%Y-%m-%d').date()
    events = sp.get(f'/sports/{rule["odds"]}/odds', {'bookmakers': 'draftkings', 'markets': 'spreads', 'oddsFormat': 'american'}, 1, http)
    form, avg, edge = form_model(sport, today)
    placed = []
    for e in events:
        start = datetime.fromisoformat(e['commence_time'].replace('Z', '+00:00'))
        if not now + timedelta(minutes=15) <= start <= now + timedelta(days=rule['lookahead_days']):
            continue
        market = next((m for b in e.get('bookmakers', []) if b['key'] == 'draftkings' for m in b['markets'] if m['key'] == 'spreads'), None)
        if not market:
            continue
        by_team = {o['name']: o for o in market['outcomes']}
        home = by_team.get(e['home_team'])
        away = by_team.get(e['away_team'])
        m = model_margin(form, avg, edge, e['home_team'], e['away_team'])
        if not home or not away or m is None:
            continue
        gap = m + home['point']  # > 0: the model has home covering.
        side = 'home' if gap >= rule['threshold'] else 'away' if gap <= -rule['threshold'] else None
        if not side:
            continue
        bet = {'sport': sport, 'day': nb.eastern_day(e['commence_time']), 'event': e['id'], 'home': e['home_team'],
               'away': e['away_team'], 'start': e['commence_time'], 'side': side, 'home_spread': home['point'],
               'odds': (home if side == 'home' else away)['price'], 'model': round(m, 2)}
        if bets.add(bet):
            placed.append(bet)
    if say and placed:
        say({'at': time.time(), 'trade': f'{sport.lower()}-spreads-{today}', 'event': f'{sport} spreads',
             'title': f'{len(placed)} paper {sport} spread bet{"s" if len(placed) != 1 else ""}',
             'message': ' | '.join(f'{b["home"] if b["side"] == "home" else b["away"]} '
                                   f'{(b["home_spread"] if b["side"] == "home" else -b["home_spread"]):+g} '
                                   f'({b["away"]} at {b["home"]}), {b["odds"]:+g}' for b in placed)})
    return {'placed': placed, 'credits_left': sp.credits_left(), **bets.summary()}


def settle(bets: Bets | None = None, today: date | None = None) -> dict:
    bets = bets or Bets()
    today = today or date.today()
    settled = 0
    for sport in RULES:
        open_bets = [b for b in bets.rows('sport=? AND result IS NULL', (sport,)) if b['day'] < today.isoformat()]
        if not open_bets:
            continue
        finished = sl.games(RULES[sport]['history'], end=(today - timedelta(days=1)).isoformat())
        for b in open_bets:
            g = next((g for g in finished if g['date'] == b['day'] and nb.same_team(g['home'], b['home'])
                      and nb.same_team(g['away'], b['away'])), None)
            if not g:
                continue
            cover = g['home_pts'] - g['away_pts'] + b['home_spread']
            if cover == 0:
                result, profit = 'push', 0.0
            else:
                won = (cover > 0) == (b['side'] == 'home')
                result, profit = ('won', round(STAKE * nr.payout(b['odds']), 2)) if won else ('lost', -STAKE)
            with closing(sqlite3.connect(bets.path)) as db, db:
                db.execute('UPDATE line_paper SET result=?, profit=? WHERE id=?', (result, profit, b['id']))
            settled += 1
    return {'settled': settled, **bets.summary()}


if __name__ == '__main__':
    import sys
    args = sys.argv[1:] or ['status']
    if args[0] == 'scan':
        import options_watch
        print(json.dumps(scan(args[1], say=options_watch.notify), indent=1, default=str))
    elif args[0] == 'settle':
        print(json.dumps(settle(), indent=1))
    else:
        print(json.dumps(Bets().summary(), indent=1))
