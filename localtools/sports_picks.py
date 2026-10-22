"""Sports picks: 2-pick parlays where DraftKings pays more than the fair odds.

"Most likely to happen" is not the same as "worth betting": every sportsbook
price carries the book's margin, and a parlay multiplies it. So each pick's
fair chance is taken from the market itself: the sharpest book (Pinnacle) when
it prices the same line, otherwise the median of the other books, each with
its margin removed. A pick qualifies only if DraftKings' price beats that fair
chance by MIN_EDGE; parlays pair two qualifying picks from different games
(independent), ranked by expected value, with their hit chance shown.

Everything is a paper record first (the owner's demo-first rule): parlays are
logged, settled from final scores, and scored (hit rate, profit at a $10
stake, expected vs actual). On DraftKings the owner presses Place Bet; the Dots
never do (order_guard.py).

Odds and scores: The Odds API (the-odds-api.com), key ODDS_API_KEY in
OpenDots' .env. Credits are tracked from its response headers and a reserve is
kept, so the free monthly allowance is never overrun.

Run: python sports_picks.py picks | settle | status
"""
from __future__ import annotations

import json
import os
import sqlite3
import statistics
import time
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = 'https://api.the-odds-api.com/v4'
DB = ROOT / 'data' / 'sports-picks.sqlite'
USAGE = ROOT / 'data' / 'sports-usage.json'
SPORTS = ('basketball_nba', 'americanfootball_nfl', 'baseball_mlb', 'icehockey_nhl')  # Priority order.
BOOKS = ('draftkings,pinnacle,fanduel,betmgm,williamhill_us,betrivers,lowvig,betonlineag,bovada,mybookieag')
MARKETS = 'h2h,spreads,totals'  # 3 credits per sport with up to 10 named books.
DK = 'draftkings'
SHARP = 'pinnacle'
MIN_EDGE = 0.02        # DraftKings' price at least 2% above fair value, per pick.
MIN_BOOKS = 3          # Without the sharp book, at least this many other books must price the line.
MIN_HIT = 0.30         # A 2-pick parlay must have at least this chance of hitting.
LOOKAHEAD_H = 24       # Games starting in the next 24 hours.
STAKE = 10.0           # Paper stake per parlay.
RESERVE = 25           # Credits never spent (for settling what is already logged).


# The Odds API -------------------------------------------------------------------
def api_key() -> str:
    key = os.environ.get('ODDS_API_KEY', '').strip()
    if not key and (ROOT / '.env').exists():
        for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
            if line.strip().startswith('ODDS_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"\'')
    if not key:
        raise LookupError('No Odds API key: add ODDS_API_KEY=... to OpenDots\' .env (free at the-odds-api.com).')
    return key


def credits_left() -> int | None:
    try:
        return json.loads(USAGE.read_text())['remaining']
    except (OSError, ValueError, KeyError):
        return None


def get(path: str, params: dict, cost: int = 0, http=None):
    """One API call. Refuses when it would dip into the reserve."""
    left = credits_left()
    if cost and left is not None and left - cost < RESERVE:
        raise RuntimeError(f'Odds API credits low ({left} left, {RESERVE} kept in reserve): skipped until the monthly reset.')
    if http is None:
        import requests
        http = requests.get
    response = http(f'{API}{path}', params={**params, 'apiKey': api_key()}, timeout=30)
    response.raise_for_status()
    remaining = response.headers.get('x-requests-remaining')
    if remaining is not None:
        USAGE.parent.mkdir(parents=True, exist_ok=True)
        USAGE.write_text(json.dumps({'remaining': int(float(remaining)), 'used': int(float(response.headers.get('x-requests-used', 0))),
                                     'at': time.time()}))
    return response.json()


def in_season(http=None) -> list[str]:
    """Our sports that are in season now (this call costs nothing)."""
    active = {s['key'] for s in get('/sports', {}, 0, http) if s.get('active')}
    return [s for s in SPORTS if s in active]


SNAPSHOTS = ROOT / 'data' / 'sports-odds'


def odds(sport: str, http=None) -> list[dict]:
    events = get(f'/sports/{sport}/odds', {'bookmakers': BOOKS, 'markets': MARKETS, 'oddsFormat': 'decimal'},
                 len(MARKETS.split(',')), http)
    if http is None:  # Kept: our own odds history, and a record of what each pick was judged on.
        import gzip
        now = datetime.now()
        path = SNAPSHOTS / now.strftime('%Y-%m-%d') / f'{sport}-{now:%H%M}.json.gz'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(json.dumps(events).encode()))
    return events


def scores(sport: str, http=None) -> list[dict]:
    return get(f'/sports/{sport}/scores', {'daysFrom': 3}, 2, http)


# Fair chances and edges -------------------------------------------------------------
def no_vig(outcomes: list[dict]) -> dict:
    """A market's outcomes with the book's margin removed: {(name, point): chance}."""
    implied = {(o['name'], o.get('point')): 1 / o['price'] for o in outcomes if o.get('price', 0) > 1}
    total = sum(implied.values())
    return {k: v / total for k, v in implied.items()} if total > 0 and len(implied) >= 2 else {}


def picks(events: list[dict], now: datetime | None = None) -> list[dict]:
    """Every DraftKings line in the next LOOKAHEAD_H hours with its fair chance and edge."""
    now = now or datetime.now(timezone.utc)
    out = []
    for event in events:
        start = datetime.fromisoformat(event['commence_time'].replace('Z', '+00:00'))
        if not now + timedelta(minutes=10) <= start <= now + timedelta(hours=LOOKAHEAD_H):
            continue
        books = {b['key']: {m['key']: m['outcomes'] for m in b.get('markets', [])} for b in event.get('bookmakers', [])}
        if DK not in books:
            continue
        for market, outcomes in books[DK].items():
            dk = {(o['name'], o.get('point')): o['price'] for o in outcomes}
            sharp = no_vig(books.get(SHARP, {}).get(market, []))
            others = [no_vig(b.get(market, [])) for key, b in books.items() if key not in (DK, SHARP)]
            for outcome, price in dk.items():
                if outcome in sharp:
                    fair, source = sharp[outcome], 'Pinnacle'
                else:
                    seen = [o[outcome] for o in others if outcome in o]
                    if len(seen) < MIN_BOOKS:
                        continue
                    fair, source = statistics.median(seen), f'median of {len(seen)} books'
                out.append({'event': event['id'], 'sport': event['sport_key'], 'home': event['home_team'],
                            'away': event['away_team'], 'start': event['commence_time'], 'market': market,
                            'name': outcome[0], 'point': outcome[1], 'price': price, 'fair': round(fair, 4),
                            'edge': round(fair * price - 1, 4), 'source': source})
    return out


def parlays(found: list[dict], top: int = 3) -> list[dict]:
    """2-pick parlays from picks with an edge, in different games (independent), that
    hit often enough; ranked by expected value."""
    good = [p for p in found if p['edge'] >= MIN_EDGE]
    out = []
    for a, b in combinations(good, 2):
        if a['event'] == b['event']:
            continue  # Same game: the legs are linked and DraftKings prices that in.
        hit = a['fair'] * b['fair']
        price = a['price'] * b['price']
        if hit < MIN_HIT:
            continue
        out.append({'legs': [a, b], 'price': round(price, 3), 'hit': round(hit, 4), 'ev': round(hit * price - 1, 4)})
    out.sort(key=lambda p: p['ev'], reverse=True)
    chosen, used = [], set()
    for p in out:  # Each pick in one parlay at most, so one bad pick cannot sink several.
        keys = {(leg['event'], leg['market'], leg['name'], leg['point']) for leg in p['legs']}
        if keys & used:
            continue
        chosen.append(p)
        used |= keys
        if len(chosen) == top:
            break
    return chosen


def describe(leg: dict) -> str:
    game = f'{leg["away"]} at {leg["home"]}'
    if leg['market'] == 'h2h':
        what = f'{leg["name"]} to win'
    elif leg['market'] == 'spreads':
        what = f'{leg["name"]} {leg["point"]:+g}'
    else:
        what = f'{leg["name"]} {leg["point"]:g}'
    return f'{what} ({game}) at {leg["price"]:.2f}, fair chance {leg["fair"]:.0%}'


# The paper journal ------------------------------------------------------------------
class Journal:
    def __init__(self, path=DB):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS parlays(id TEXT PRIMARY KEY, ts REAL, day TEXT, data TEXT, '
                       'status TEXT, payout REAL, settled_ts REAL, placed INTEGER DEFAULT 0)')

    def rows(self, where='1=1', args=()):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [{**dict(r), 'data': json.loads(r['data'])} for r in db.execute(f'SELECT * FROM parlays WHERE {where} ORDER BY ts', args)]

    def add(self, parlay: dict) -> str:
        key = sorted((leg['event'], leg['market'], leg['name'], str(leg['point'])) for leg in parlay['legs'])
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        for row in self.rows('day=?', (day,)):
            if sorted((l['event'], l['market'], l['name'], str(l['point'])) for l in row['data']['legs']) == key:
                return row['id']
        identity = uuid.uuid4().hex[:8]
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO parlays(id, ts, day, data, status) VALUES(?,?,?,?,?)',
                       (identity, time.time(), day, json.dumps(parlay), 'open'))
        return identity

    def mark_placed(self, identity: str) -> None:
        """The owner placed this one on DraftKings (real money, counted apart)."""
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE parlays SET placed=1 WHERE id=?', (identity,))

    def settle(self, finals: dict) -> int:
        """finals: {event id: {'home': score, 'away': score, 'home_team', 'away_team'}} for completed games."""
        settled = 0
        for row in self.rows("status='open'"):
            results = [leg_result(leg, finals.get(leg['event'])) for leg in row['data']['legs']]
            if None in results:
                continue  # A game not finished (or not found yet).
            if 'lost' in results:
                status, payout = 'lost', -STAKE
            else:
                price = 1.0
                for leg, result in zip(row['data']['legs'], results):
                    if result == 'won':
                        price *= leg['price']  # A pushed leg drops out, as sportsbooks settle it.
                status, payout = ('won', round(STAKE * (price - 1), 2)) if price > 1 else ('push', 0.0)
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('UPDATE parlays SET status=?, payout=?, settled_ts=? WHERE id=?',
                           (status, payout, time.time(), row['id']))
            settled += 1
        return settled

    def summary(self) -> dict:
        done = self.rows("status IN ('won', 'lost', 'push')")
        decided = [r for r in done if r['status'] != 'push']
        expected = sum(r['data']['ev'] * STAKE for r in done)
        return {'parlays': len(done), 'open': len(self.rows("status='open'")),
                'hit_rate': round(sum(r['status'] == 'won' for r in decided) / len(decided), 3) if decided else None,
                'expected_hit_rate': round(sum(r['data']['hit'] for r in decided) / len(decided), 3) if decided else None,
                'profit': round(sum(r['payout'] for r in done), 2), 'expected_profit': round(expected, 2),
                'roi': round(sum(r['payout'] for r in done) / (STAKE * len(done)), 3) if done else None,
                'real_bets_placed': sum(r['placed'] for r in done)}


def leg_result(leg: dict, final: dict | None) -> str | None:
    """'won', 'lost', 'push', or None while the game is not final."""
    if not final:
        return None
    mine, theirs = (final['home'], final['away']) if leg['name'] == final['home_team'] else (final['away'], final['home'])
    if leg['market'] == 'h2h':
        return 'push' if mine == theirs else 'won' if mine > theirs else 'lost'
    if leg['market'] == 'spreads':
        margin = mine + leg['point'] - theirs
        return 'push' if margin == 0 else 'won' if margin > 0 else 'lost'
    total = final['home'] + final['away']
    if total == leg['point']:
        return 'push'
    return 'won' if (total > leg['point']) == (leg['name'] == 'Over') else 'lost'


def finals_from(events: list[dict]) -> dict:
    out = {}
    for e in events:
        if not e.get('completed') or not e.get('scores'):
            continue
        points = {s['name']: float(s['score']) for s in e['scores']}
        out[e['id']] = {'home_team': e['home_team'], 'away_team': e['away_team'],
                        'home': points.get(e['home_team'], 0.0), 'away': points.get(e['away_team'], 0.0)}
    return out


# Daily runs -------------------------------------------------------------------------
def run_picks(journal: Journal | None = None, http=None, say=None) -> dict:
    journal = journal or Journal()
    found, skipped = [], []
    for sport in in_season(http):
        try:
            found += picks(odds(sport, http))
        except RuntimeError as error:  # Credits low: the rest wait.
            skipped.append(f'{sport}: {error}')
            break
    chosen = parlays(found)
    for p in chosen:
        p['id'] = journal.add(p)
    if say and chosen:
        say({'at': time.time(), 'trade': f'parlays-{datetime.now():%Y-%m-%d}', 'event': 'parlays',
             'title': f'{len(chosen)} paper parlay{"s" if len(chosen) != 1 else ""} for today',
             'message': ' | '.join(f'{p["hit"]:.0%} to hit, pays {p["price"]:.2f}x, expected {p["ev"]:+.0%}: '
                                   + ' + '.join(describe(l) for l in p['legs']) for p in chosen)})
    return {'lines_priced': len(found), 'with_edge': sum(p['edge'] >= MIN_EDGE for p in found),
            'parlays': chosen, 'skipped': skipped, 'credits_left': credits_left()}


def run_settle(journal: Journal | None = None, http=None) -> dict:
    journal = journal or Journal()
    open_sports = {leg['sport'] for r in journal.rows("status='open'") for leg in r['data']['legs']}
    finals = {}
    for sport in sorted(open_sports):
        try:
            finals.update(finals_from(scores(sport, http)))
        except RuntimeError:
            break
    return {'settled': journal.settle(finals), **journal.summary(), 'credits_left': credits_left()}


def register(tool, journal: Journal | None = None) -> None:
    journal = journal or Journal()

    @tool()
    def sports_parlays() -> dict:
        """Today's paper 2-pick parlays: picks where DraftKings pays more than the fair
        odds (Pinnacle's, or the median of other books, margin removed), from different
        games, with each parlay's chance to hit and expected value. Logged as a paper
        record. Never place a bet: on DraftKings the owner presses Place Bet."""
        return run_picks(journal)

    @tool()
    def sports_record(parlay_id: str = '', placed: bool = False) -> dict:
        """The paper record so far (settled from final scores): hit rate against the
        expected hit rate, profit at a $10 stake, ROI. placed=True with a parlay_id notes
        that the owner placed that parlay for real."""
        if parlay_id and placed:
            journal.mark_placed(parlay_id)
        return {**journal.summary(), 'recent': [{'id': r['id'], 'day': r['day'], 'status': r['status'], 'payout': r['payout'],
                                                 'legs': [describe(l) for l in r['data']['legs']]}
                                                for r in journal.rows()[-10:]]}


if __name__ == '__main__':
    import sys
    command = (sys.argv[1:] or ['status'])[0]
    if command == 'picks':
        import options_watch
        print(json.dumps(run_picks(say=options_watch.notify), indent=1, default=str))
    elif command == 'settle':
        print(json.dumps(run_settle(), indent=1))
    else:
        print(json.dumps({**Journal().summary(), 'credits_left': credits_left()}, indent=1))
