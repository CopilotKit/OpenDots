"""NBA player points props: our chance of over/under vs DraftKings' price.

The model, per player and game, from his earlier games only (nba_data.py, ESPN):
- minutes: a recent-weighted average of his last 10 games;
- scoring rate: points per minute over his last 25 games, recent ones weighted more
  (last season's games fill in while this season is young);
- opponent: how many points that team allows against the league average (halved,
  so one soft schedule does not swing it);
- spread: a negative binomial around that mean, its width fitted on past games
  (scoring is lopsided: a few 40-point nights lift the average, so the typical
  night sits below it, and unders hit more than "average vs line" suggests).

A prop qualifies when our chance beats DraftKings' price by MIN_EDGE, the other
books' prices for the same line do not disagree (when there are any), the player
projects to real minutes and is not listed Out or Doubtful. Pairs from different
games make the 2-pick parlays; everything is a paper record in sports_picks'
journal, settled from the box scores.

Run: python nba_props.py calibrate | picks | settle
"""
from __future__ import annotations

import json
import math
import re
import statistics
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import nba_data
import sports_picks as sp

MIN_EDGE = 0.05          # Our chance x DraftKings' price at least 5% above break-even.
MARKET_FLOOR = -0.02     # The other books' fair price may not say it is worse than this.
MAX_EDGE = 0.25          # Beyond this, our model is more likely wrong than the whole market.
MIN_SEASON_GAMES = 3     # A player who changed teams: games with his new team before his props are judged.
MIN_MINUTES = 20.0
MIN_GAMES = 8
SPORT = 'basketball_nba'
REPORT = Path(__file__).resolve().parent.parent / 'data' / 'nba-props-calibration.json'
# Spread of points around the mean: variance = A * mean + B * mean^2 (fitted by `calibrate`).
SPREAD_FILE = Path(__file__).resolve().parent.parent / 'data' / 'nba-props-spread.json'
DEFAULT_SPREAD = (1.6, 0.06)


def norm(name: str) -> str:
    name = re.sub(r'[^a-z ]', '', name.lower().replace('-', ' '))
    return ' '.join(w for w in name.split() if w not in ('jr', 'sr', 'ii', 'iii', 'iv'))


def nickname(team: str) -> str:
    """"LA Clippers" (ESPN) and "Los Angeles Clippers" (The Odds API) are the same team."""
    return team.split()[-1].lower() if team else ''


def same_team(a: str, b: str) -> bool:
    return nickname(a) == nickname(b)


def eastern_day(iso: str) -> str:
    """The New York date of a UTC time (games after 8pm ET start on the next UTC day)."""
    import options_guide as og
    t = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(timezone.utc).replace(tzinfo=None)
    return og.eastern(t).date().isoformat()


# History --------------------------------------------------------------------------
class History:
    """Player lines by player and team points by game, for "before this date" lookups."""

    def __init__(self, rows: list[dict]):
        self.by_player = defaultdict(list)
        team_points = defaultdict(lambda: defaultdict(int))
        meta = {}
        for r in rows:
            self.by_player[norm(r['player'])].append(r)
            team_points[r['game']][r['team']] += r['pts']
            meta[(r['game'], r['team'])] = (r['date'], r['opponent'])
        self.allowed = defaultdict(list)  # Team -> [(date, points scored against it)].
        self.league = []                  # [(date, a team's points in a game)].
        for (game, team), (day, opponent) in meta.items():
            self.allowed[opponent].append((day, team_points[game][team]))
            self.league.append((day, team_points[game][team]))
        for v in self.allowed.values():
            v.sort()
        self.league.sort()

    def player_before(self, name: str, day: str) -> list[dict]:
        return [r for r in self.by_player.get(norm(name), []) if r['date'] < day]

    def opponent_factor(self, opponent: str, day: str) -> float:
        allowed = [p for d, p in self.allowed.get(opponent, []) if d < day][-20:]
        league = [p for d, p in self.league if d < day][-600:]
        if len(allowed) < 5 or not league:
            return 1.0
        return math.sqrt(statistics.mean(allowed) / statistics.mean(league))  # Halved (square root).


def projection(games: list[dict], factor: float = 1.0) -> dict | None:
    """Mean points from the player's earlier games (oldest first), or None if too few."""
    recent = games[-25:]
    if len(recent) < MIN_GAMES:
        return None
    weights = [0.92 ** k for k in range(len(recent))][::-1]
    last = recent[-10:]
    minute_weights = [0.85 ** k for k in range(len(last))][::-1]
    minutes = sum(w * g['min'] for w, g in zip(minute_weights, last)) / sum(minute_weights)
    rate = sum(w * g['pts'] for w, g in zip(weights, recent)) / max(sum(w * g['min'] for w, g in zip(weights, recent)), 1)
    return {'mean': max(minutes * rate * factor, 0.5), 'minutes': minutes, 'rate': rate, 'games': len(recent)}


def spread():
    """The fitted shape (bias, variance and the real distribution of misses), or the default."""
    try:
        saved = json.loads(SPREAD_FILE.read_text())
        return saved if isinstance(saved, dict) else DEFAULT_SPREAD
    except (OSError, ValueError):
        return DEFAULT_SPREAD


def chance(mean: float, line: float, shape) -> float:
    """P(points > line). With a fitted shape: the projection corrected for its average miss,
    and the misses' real distribution (scaled to this player's spread) - no assumed curve."""
    if not isinstance(shape, dict):
        return chance_over(mean, line, *shape)
    import numpy as np
    centre = mean + shape['bias']
    sd = math.sqrt(max(shape['a'] * centre + shape['b'] * centre * centre, 1.0))
    z = (line - centre) / sd
    quantiles = np.array(shape['quantiles'])
    below = float(np.interp(z, quantiles, np.linspace(0, 1, len(quantiles))))
    return min(max(1 - below, 1e-4), 1 - 1e-4)


def chance_over(mean: float, line: float, a: float, b: float) -> float:
    """P(points > line) for a half-point line, negative binomial with variance a*mean + b*mean^2."""
    variance = max(a * mean + b * mean * mean, mean * 1.01)
    r = mean * mean / (variance - mean)
    p = r / (r + mean)
    k_max = math.floor(line)
    total, log_p, log_q = 0.0, math.log(p), math.log(1 - p)
    for k in range(k_max + 1):
        total += math.exp(math.lgamma(k + r) - math.lgamma(r) - math.lgamma(k + 1) + r * log_p + k * log_q)
    return min(max(1 - total, 1e-6), 1 - 1e-6)


# Calibration: is the model honest about its chances? ----------------------------------
def samples(rows: list[dict], start: str, end: str) -> list[tuple[float, int, dict]]:
    """(projected mean, actual points, projection) for every player game in [start, end)
    with enough earlier games."""
    h = History(rows)
    out = []
    for r in rows:
        if not start <= r['date'] < end or r['min'] < 10:
            continue
        p = projection(h.player_before(r['player'], r['date']), h.opponent_factor(r['opponent'], r['date']))
        if p and p['minutes'] >= 15:
            out.append((p['mean'], r['pts'], {**p, 'date': r['date']}))
    return out


def fit_spread(data) -> tuple[float, float]:
    """variance = a*mean + b*mean^2, least squares over mean bins."""
    bins = defaultdict(list)
    for mean, pts, _ in data:
        bins[round(mean / 3)].append((mean, (pts - mean) ** 2))
    xs = [(statistics.mean(m for m, _ in v), statistics.mean(e for _, e in v)) for v in bins.values() if len(v) >= 50]
    import numpy as np
    X = np.array([[m, m * m] for m, _ in xs])
    y = np.array([v for _, v in xs])
    a, b = np.linalg.lstsq(X, y, rcond=None)[0]
    return max(float(a), 1.05), max(float(b), 0.0)


def fit_shape(data) -> dict:
    """The projection's average miss, its spread (variance = a*mean + b*mean^2) and the real
    distribution of standardized misses (101 quantiles)."""
    import numpy as np
    bias = statistics.mean(pts - mean for mean, pts, _ in data)
    shifted = [(mean + bias, pts, p) for mean, pts, p in data]
    a, b = fit_spread(shifted)
    z = sorted((pts - m) / math.sqrt(max(a * m + b * m * m, 1.0)) for m, pts, _ in shifted)
    return {'bias': bias, 'a': a, 'b': b, 'quantiles': [float(q) for q in np.quantile(z, np.linspace(0, 1, 101))]}


def drift(recent, shape) -> float:
    """How far projections have missed lately (the last ~3 weeks, at least 300 player games),
    beyond the fitted bias: late-season scoring, pace changes. 0 without enough games."""
    if len(recent) < 300:
        return 0.0
    return statistics.mean(pts - mean for mean, pts, _ in recent) - shape['bias']


def calibrate(rows: list[dict] | None = None, log=print) -> dict:
    """Fit the shape on the first half of last season, then judge the model's chances on
    the second half with lines around each projection (real past prop lines are not free)."""
    rows = rows or nba_data.load(log=log)
    fit = samples(rows, '2025-11-15', '2026-01-31')
    shape = fit_shape(fit)
    a, b = shape['a'], shape['b']
    test = samples(rows, '2026-02-01', '2026-04-13')
    buckets = defaultdict(lambda: [0, 0, 0.0])
    loss, naive_loss, n = 0.0, 0.0, 0
    from bisect import bisect_left
    pool = sorted(fit + test, key=lambda s: s[2]['date'])
    dates = [s[2]['date'] for s in pool]
    for mean, pts, p in test:
        day = p['date']
        window = pool[bisect_left(dates, (date.fromisoformat(day) - timedelta(days=21)).isoformat()):bisect_left(dates, day)]
        mean = mean + drift(window, shape)  # Only earlier days' misses.
        for offset in (-4, -2, 0, 2, 4):
            line = math.floor(mean) + 0.5 + offset  # Half-point lines around the projection.
            q = chance(mean, line, shape)
            over = pts > line
            bucket = buckets[min(int(q * 10), 9)]
            bucket[0] += 1
            bucket[1] += over
            bucket[2] += q
            loss -= math.log(q if over else 1 - q)
            # Naive: a normal curve around the plain average, as "average vs line" would.
            sd = max(math.sqrt(mean) * 1.9, 1)
            z = (line - mean) / sd
            naive = min(max(1 - 0.5 * (1 + math.erf(z / math.sqrt(2))), 1e-6), 1 - 1e-6)
            naive_loss -= math.log(naive if over else 1 - naive)
            n += 1
    table = [{'predicted': round(v[2] / v[0], 3), 'happened': round(v[1] / v[0], 3), 'n': v[0]}
             for k, v in sorted(buckets.items()) if v[0]]
    result = {'spread': [round(a, 3), round(b, 4)], 'fit_bias': round(shape['bias'], 2), 'fit_games': len(fit),
              'test_games': len(test), 'log_loss': round(loss / n, 4), 'naive_log_loss': round(naive_loss / n, 4),
              'test_bias_before_correction': round(statistics.mean(pts - mean for mean, pts, _ in test), 2),
              'calibration': table}
    SPREAD_FILE.write_text(json.dumps(shape))
    REPORT.write_text(json.dumps(result, indent=1))
    return result


# Tonight's props -------------------------------------------------------------------
def prop_odds(event_id: str, http=None) -> dict:
    data = sp.get(f'/sports/{SPORT}/events/{event_id}/odds',
                  {'bookmakers': sp.BOOKS, 'markets': 'player_points', 'oddsFormat': 'decimal'}, 1, http)
    if http is None:
        import gzip
        path = sp.SNAPSHOTS / datetime.now().strftime('%Y-%m-%d') / f'props-{event_id}-{datetime.now():%H%M}.json.gz'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(json.dumps(data).encode()))
    return data


def evaluate(event: dict, h: History, out_list: dict, now: datetime, shape, shift: float = 0.0) -> list[dict]:
    """Every DraftKings points prop in a game, with our chance, the market's and the edges."""
    books = {bk['key']: bk for bk in event.get('bookmakers', [])}
    if sp.DK not in books:
        return []
    day = eastern_day(event['commence_time'])
    lines = defaultdict(dict)  # (player, point) -> book -> {Over: price, Under: price}
    for key, bk in books.items():
        for market in bk.get('markets', []):
            if market['key'] != 'player_points':
                continue
            for o in market['outcomes']:
                lines[(o.get('description', ''), o.get('point'))].setdefault(key, {})[o['name']] = o['price']
    out = []
    for (player, point), by_book in lines.items():
        dk = by_book.get(sp.DK, {})
        if point is None or 'Over' not in dk or 'Under' not in dk:
            continue
        if out_list.get(player, '').lower() in ('out', 'doubtful'):
            continue
        games = h.player_before(player, day)
        if not games:
            continue
        team = games[-1]['team']
        if not (same_team(team, event['home_team']) or same_team(team, event['away_team'])):
            continue  # Changed teams: his old games describe a different role.
        with_team = [g for g in games if g['date'] >= season_start(day) and g['team'] == team]
        if len({g['team'] for g in games[-25:]}) > 1 and len(with_team) < MIN_SEASON_GAMES:
            continue  # Changed teams: his old games describe another role until he has a few with the new one.
        other = event['away_team'] if same_team(team, event['home_team']) else event['home_team']
        opponent = next((t for t in h.allowed if same_team(t, other)), other)  # ESPN's name for the history.
        p = projection(games, h.opponent_factor(opponent, day))
        if not p or p['minutes'] < MIN_MINUTES:
            continue
        over = chance(p['mean'] + shift, point, shape)
        fair_market = []
        for key, prices in by_book.items():
            if key != sp.DK and 'Over' in prices and 'Under' in prices:
                inv = 1 / prices['Over'] + 1 / prices['Under']
                fair_market.append((1 / prices['Over']) / inv)
        market_over = statistics.median(fair_market) if len(fair_market) >= 2 else None
        for side, ours, market in (('Over', over, market_over), ('Under', 1 - over, None if market_over is None else 1 - market_over)):
            price = dk[side]
            out.append({'event': event['id'], 'sport': SPORT, 'home': event['home_team'], 'away': event['away_team'],
                        'start': event['commence_time'], 'market': 'player_points', 'player': player,
                        'name': side, 'point': point, 'price': price, 'fair': round(ours, 4),
                        'edge': round(ours * price - 1, 4),
                        'market_edge': None if market is None else round(market * price - 1, 4),
                        'projection': round(p['mean'], 1), 'minutes': round(p['minutes'], 1),
                        'source': f'model ({p["games"]} games; {len(fair_market)} other books)'})
    return out


def qualifies(leg: dict) -> bool:
    """Our edge, confirmed by the market not disagreeing (at least 2 other books required), and
    not so large that it is more likely our model is wrong than the whole market."""
    return (MIN_EDGE <= leg['edge'] <= MAX_EDGE and leg['market_edge'] is not None
            and leg['market_edge'] >= MARKET_FLOOR)


def season_start(day: str) -> str:
    """The start of the season `day` falls in (from nba_data.SEASONS)."""
    starts = [start for _, start, _ in nba_data.SEASONS if start <= day]
    return max(starts) if starts else '0000'


def run_picks(journal: sp.Journal | None = None, http=None, rows=None, say=None, now=None) -> dict:
    journal = journal or sp.Journal()
    now = now or datetime.now(timezone.utc)
    shape = spread()
    today = (now - timedelta(hours=4)).date()
    all_rows = rows if rows is not None else nba_data.load(log=lambda *x: None)
    shift = drift(samples(all_rows, (today - timedelta(days=21)).isoformat(), today.isoformat()), shape)         if isinstance(shape, dict) else 0.0
    rows = all_rows
    h = History(rows if rows is not None else nba_data.load(log=lambda *x: None))
    window = {'commenceTimeFrom': (now + timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%SZ'),
              'commenceTimeTo': (now + timedelta(hours=sp.LOOKAHEAD_H)).strftime('%Y-%m-%dT%H:%M:%SZ')}
    events = sp.get(f'/sports/{SPORT}/events', window, 0, http)  # Free.
    hurt = nba_data.injuries() if http is None else {}
    legs, skipped = [], []
    for e in events:
        try:
            legs += evaluate({**e, **prop_odds(e['id'], http)}, h, hurt, now, shape, shift)
        except RuntimeError as error:  # Credits low.
            skipped.append(str(error))
            break
    good = [leg for leg in legs if qualifies(leg)]
    chosen = sp.parlays(good)
    for p in chosen:
        p['id'] = journal.add(p)
    if say and chosen:
        say({'at': time.time(), 'trade': f'nba-props-{now:%Y-%m-%d}', 'event': 'nba props',
             'title': f'{len(chosen)} paper NBA points parlay{"s" if len(chosen) != 1 else ""} for tonight',
             'message': ' | '.join(f'{p["hit"]:.0%} to hit, pays {p["price"]:.2f}x, expected {p["ev"]:+.0%}: '
                                   + ' + '.join(sp.describe(l) for l in p['legs']) for p in chosen)})
    return {'games': len(events), 'props_priced': len(legs), 'qualifying': len(good),
            'best': sorted(legs, key=lambda l: -l['edge'])[:8], 'parlays': chosen, 'skipped': skipped,
            'credits_left': sp.credits_left()}


def run_settle(journal: sp.Journal | None = None, rows=None) -> dict:
    """Settles open parlays made only of points props, from the box scores. A player who
    did not play voids his leg (as sportsbooks do)."""
    journal = journal or sp.Journal()
    settled = 0
    for row in journal.rows("status='open'"):
        legs = row['data']['legs']
        if not all(l['market'] == 'player_points' for l in legs):
            continue
        results = []
        for leg in legs:
            day = date.fromisoformat(eastern_day(leg['start']))
            games = [g for g in nba_data.games_on(day) if {nickname(g['home']), nickname(g['away'])}
                     == {nickname(leg['home']), nickname(leg['away'])}]
            if not games or not games[0]['final']:
                results.append(None)
                continue
            line = next((r for r in nba_data.box(games[0]['id']) if norm(r['player']) == norm(leg['player'])), None)
            if line is None:
                results.append('push')  # Did not play.
            else:
                results.append('push' if line['pts'] == leg['point'] else
                               'won' if (line['pts'] > leg['point']) == (leg['name'] == 'Over') else 'lost')
        if None in results:
            continue
        journal.close(row['id'], *sp.outcome(legs, results))
        settled += 1
    return {'settled': settled, **journal.summary()}


def register(tool, journal: sp.Journal | None = None) -> None:
    journal = journal or sp.Journal()

    @tool()
    def sports_nba_props() -> dict:
        """Tonight's NBA points props: our chance of over/under (from each player's recent
        minutes and scoring, the opponent and a fitted spread) against DraftKings' price,
        checked against the other books; 2-pick paper parlays from the ones with an edge.
        Never place a bet: on DraftKings the owner presses Place Bet."""
        return run_picks(journal)


if __name__ == '__main__':
    import sys
    command = (sys.argv[1:] or ['picks'])[0]
    if command == 'calibrate':
        print(json.dumps(calibrate(), indent=1))
    elif command == 'settle':
        print(json.dumps(run_settle(), indent=1))
    else:
        import options_watch
        print(json.dumps(run_picks(say=options_watch.notify), indent=1, default=str))
