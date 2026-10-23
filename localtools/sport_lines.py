"""The NBA opener test, for other sports: does a simple team-scoring model beat
DraftKings' opening totals and spreads, and does the line move toward it?

Per sport (ESPN's free scoreboard and core odds feed): every finished game of the
last season with its final score and DraftKings' (else the first book's) opening and
closing lines. The model, from earlier games only and blind to the previous day: each
team's points for and against over its last N games; expected points = own attack x
opponent's defence / league average; home edge fitted on the training games.
Judged as in the NBA research: thresholds chosen on the first 60%, tested on the rest,
plus the share of games whose line moved toward the model (closing-line value).

Run: python sport_lines.py   (adds a section to "NBA Edge Research.md")
"""
from __future__ import annotations

import gzip
import json
import math
import statistics
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import nba_research as nr

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'sports-history'
SPORTS = {
    'NHL': ('hockey', 'nhl', '2025-10-07', '2026-04-16', 15),
    'MLB': ('baseball', 'mlb', '2026-03-26', '2026-09-27', 20),
    'NFL': ('football', 'nfl', '2025-09-04', '2026-01-04', 6),
    # Last season to choose on, this season (weeks 1-7) as a fully unseen second test.
    'NFL+2026': ('football', 'nfl', '2025-09-04', '2026-10-20', 6),
    'NCAAF+2026': ('football', 'college-football', '2025-08-23', '2026-10-20', 5),
}
SEASON_TEST = {'NFL+2026': '2026-08-01', 'NCAAF+2026': '2026-08-01'}


def _get(url: str, params: dict | None = None):
    import requests
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt == 2:
                raise
            import time
            time.sleep(2)


def _cached(path: Path, fetch):
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    value = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(value).encode()))
    return value


def american(node, key):
    try:
        text = ((node or {}).get(key) or {}).get('american')
        if text in (None, '', 'OFF'):
            return None
        return 100.0 if text == 'EVEN' else float(str(text).replace('+', ''))
    except ValueError:
        return None


def games(sport: str, end: str | None = None) -> list[dict]:
    """Finished games with their lines. end overrides the configured last day (live use);
    the last 3 days are never cached, so late results are not missed."""
    group, league, start, configured_end, _ = SPORTS[sport]
    end = end or configured_end
    fresh = (date.today() - timedelta(days=3)).isoformat()
    base = f'https://site.api.espn.com/apis/site/v2/sports/{group}/{league}/scoreboard'
    days = []
    day = date.fromisoformat(start)
    while day <= date.fromisoformat(end):
        days.append(day)
        day += timedelta(days=1)

    def day_games(d):
        def fetch():
            out = []
            params = {'dates': d.strftime('%Y%m%d'), 'limit': 400}
            if league == 'college-football':
                params['groups'] = 80  # FBS.
            for e in _get(base, params).get('events', []):
                comp = e['competitions'][0]
                if not e['status']['type'].get('completed'):
                    continue
                teams = {c['homeAway']: c for c in comp['competitors']}
                if 'home' not in teams or 'away' not in teams:
                    continue
                out.append({'id': e['id'], 'date': d.isoformat(), 'home': teams['home']['team']['displayName'],
                            'away': teams['away']['team']['displayName'],
                            'home_pts': float(teams['home'].get('score') or 0), 'away_pts': float(teams['away'].get('score') or 0)})
            return out
        if d.isoformat() >= fresh:
            return fetch()
        return _cached(CACHE / sport / 'days' / f'{d.isoformat()}.json.gz', fetch)

    def lines(g):
        def fetch():
            url = f'https://sports.core.api.espn.com/v2/sports/{group}/leagues/{league}/events/{g["id"]}/competitions/{g["id"]}/odds'
            items = _get(url).get('items', [])
            if not items:
                return {}
            p = next((i for i in items if 'draftkings' in (i.get('provider') or {}).get('name', '').lower()), items[0])
            home, away = p.get('homeTeamOdds') or {}, p.get('awayTeamOdds') or {}
            out = {}
            for when in ('open', 'close'):
                top = p.get(when) or {}
                total = american(top, 'total')
                if total is None:
                    raw = ((top.get('total') or {}).get('alternateDisplayValue') or '').lstrip('ou')
                    try:
                        total = float(raw)
                    except ValueError:
                        total = None
                out.update({f'{when}_total': total, f'{when}_over_odds': american(top, 'over'),
                            f'{when}_under_odds': american(top, 'under'),
                            f'{when}_home_spread': american(home.get(when), 'pointSpread'),
                            f'{when}_home_spread_odds': american(home.get(when), 'spread'),
                            f'{when}_away_spread_odds': american(away.get(when), 'spread')})
            return out
        try:
            return {**g, **_cached(CACHE / sport / 'lines' / f'{g["id"]}.json.gz', fetch)}
        except Exception:
            return g

    with ThreadPoolExecutor(6) as pool:
        listed = [g for gs in pool.map(day_games, days) for g in gs]
        return list(pool.map(lines, listed))


def model_rows(sport: str, all_games: list[dict]) -> list[dict]:
    window = SPORTS[sport][4]
    form = defaultdict(lambda: deque(maxlen=window))  # team -> (scored, allowed, home?)
    league = deque(maxlen=window * 30)
    pending, rows = [], []
    for g in sorted(all_games, key=lambda g: g['date']):
        known = (date.fromisoformat(g['date']) - timedelta(days=1)).isoformat()
        for p in [p for p in pending if p['date'] < known]:  # Blind to the previous day, as in the NBA test.
            form[p['home']].append((p['home_pts'], p['away_pts']))
            form[p['away']].append((p['away_pts'], p['home_pts']))
            league.extend([p['home_pts'], p['away_pts']])
        pending = [p for p in pending if p['date'] >= known] + [g]
        fh, fa = form[g['home']], form[g['away']]
        if len(fh) < max(3, window // 3) or len(fa) < max(3, window // 3) or not league:
            continue
        avg = statistics.mean(league)
        if avg <= 0:
            continue
        att = lambda f: statistics.mean(x[0] for x in f)
        dfn = lambda f: statistics.mean(x[1] for x in f)
        home_exp = att(fh) * dfn(fa) / avg
        away_exp = att(fa) * dfn(fh) / avg
        rows.append({**g, 'model_total': home_exp + away_exp, 'model_margin': home_exp - away_exp,
                     'points': g['home_pts'] + g['away_pts'], 'margin': g['home_pts'] - g['away_pts']})
    return rows


def implied_total(line, over_odds, under_odds) -> float | None:
    """The scoring the market expects, from a total AND its prices: a 5.5 at -145 over means
    more than a 5.5 at -110. The Poisson mean whose chance of going over the line matches the
    no-vig over price. Only used to measure where the market moved, never for bets."""
    if line is None or not over_odds or not under_odds:
        return None
    po, pu = 1 / (1 + nr.payout(over_odds)), 1 / (1 + nr.payout(under_odds))
    target = po / (po + pu)
    k = math.floor(line)

    def over(lam):
        term, cdf = math.exp(-lam), math.exp(-lam)
        for i in range(1, k + 1):
            term *= lam / i
            cdf += term
        return 1 - cdf
    lo, hi = 0.01, max(line * 3, 10)
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if over(mid) < target else (lo, mid)
    return (lo + hi) / 2


def evaluate(sport: str, rows: list[dict]) -> list[dict]:
    rows = [r for r in rows if r.get('open_total') is not None and r.get('close_total') is not None]
    if len(rows) < 100:
        return [{'sport': sport, 'note': f'only {len(rows)} games with lines'}]
    first = [r for r in rows if r['date'] < SEASON_TEST.get(sport, '9999')]
    cut = first[int(len(first) * nr.SPLIT)]['date']
    season2 = SEASON_TEST.get(sport)
    train = [r for r in rows if r['date'] < cut]
    home_edge = statistics.mean(r['margin'] - r['model_margin'] for r in train)
    scale = statistics.pstdev([r['points'] for r in train]) or 1
    out = []
    for kind in ('total', 'spread'):
        thresholds = [scale * k for k in (0.1, 0.2, 0.3, 0.4)]

        def bets(rs, t):
            res, toward, moved = [], 0, 0
            for r in rs:
                if kind == 'total':
                    gap = r['model_total'] - r['open_total']
                    side = 'over' if gap >= t else 'under' if gap <= -t else None
                    if not side:
                        continue
                    if r['points'] != r['open_total'] and r.get(f'open_{side}_odds'):
                        won = (r['points'] > r['open_total']) == (side == 'over')
                        res.append(nr.payout(r[f'open_{side}_odds']) if won else -1.0)
                    # Where the market moved, in expected scoring (line and juice together).
                    a = implied_total(r['open_total'], r.get('open_over_odds'), r.get('open_under_odds'))
                    b = implied_total(r['close_total'], r.get('close_over_odds'), r.get('close_under_odds'))
                    move = (b - a) if a is not None and b is not None else 0
                    if abs(move) > 0.02 * max(r['open_total'], 1):
                        moved += 1
                        toward += (move > 0) == (r['model_total'] > a)  # Against the market's expected total.
                else:
                    if r.get('open_home_spread') is None or r.get('close_home_spread') is None:
                        continue
                    gap = (r['model_margin'] + home_edge) + r['open_home_spread']  # >0: home covers.
                    side = 'home' if gap >= t else 'away' if gap <= -t else None
                    if not side:
                        continue
                    cover = r['margin'] + r['open_home_spread']
                    if cover != 0 and r.get(f'open_{side}_spread_odds'):
                        res.append(nr.payout(r[f'open_{side}_spread_odds']) if (cover > 0) == (side == 'home') else -1.0)
                    move = r['close_home_spread'] - r['open_home_spread']
                    # A run/puck line of +-1.5 only moves by flipping sides: no reading there.
                    if move and abs(r['open_home_spread']) != 1.5:
                        moved += 1
                        toward += (move < 0) == (side == 'home')  # Spread falling = money on home.
            return nr.judge(res), (round(toward / moved, 3) if moved else None), moved

        tried = []
        for t in thresholds:
            a, clv_a, n_a = bets(train, t)
            if a.get('bets', 0) >= 30:
                tried.append((a['roi'], t, a, clv_a, n_a))
        if not tried:
            out.append({'sport': sport, 'kind': kind, 'note': 'too few bets'})
            continue
        _, t, a, clv_a, n_a = max(tried, key=lambda x: x[0])
        b, clv_b, n_b = bets([r for r in rows if cut <= r['date'] < (season2 or '9999')], t)
        extra = {}
        if season2:
            c, clv_c, n_c = bets([r for r in rows if r['date'] >= season2], t)
            extra = {'season2': c, 'clv_season2': clv_c, 'moved_season2': n_c}
        out.append({'sport': sport, 'kind': kind, 'threshold': round(t, 2), 'train': a, 'test': b, **extra,
                    'clv_train': clv_a, 'moved_train': n_a, 'clv_test': clv_b, 'moved_test': n_b, 'games': len(rows), 'cut': cut,
                    'edge': bool(a['roi'] > 0 and b.get('roi', -1) > 0 and (clv_b or 0) > 0.55 and b.get('bets', 0) >= 30)})
    return out


def write(results: list[dict]) -> None:
    def cell(s):
        return f'{s["bets"]} / {s["win_rate"]:.1%} / {s["roi"]:+.1%}' if s and s.get('bets') else '-'
    section = ['## Round 4: the opener test in other sports (NHL, MLB, NFL)', '',
               'A simple team-scoring model (attack x defence over recent games, blind to the previous day) against '
               'DraftKings\' opening total and spread, bet at the opening price; "toward" = share of games whose line '
               'then moved toward the model.', '',
               '| Sport | Market | Train: bets / win / ROI (toward) | Test: bets / win / ROI (toward) | Edge? |', '|---|---|---|---|---|']
    for e in results:
        if 'note' in e:
            section.append(f'| {e["sport"]} | {e.get("kind", "-")} | {e["note"]} | - | no |')
            continue
        section.append(f'| {e["sport"]} | {e["kind"]} | {cell(e["train"])} ({e["clv_train"] or 0:.0%}) | '
                       f'{cell(e["test"])} ({e["clv_test"] or 0:.0%}) | {"**yes**" if e["edge"] else "no"} |')
    text = nr.VAULT.read_text(encoding='utf-8') if nr.VAULT.exists() else ''
    marker = '## Round 4: the opener test in other sports (NHL, MLB, NFL)'
    nr.VAULT.write_text(text.split(marker)[0].rstrip() + '\n\n' + '\n'.join(section) + '\n', encoding='utf-8')


if __name__ == '__main__':
    import sys
    chosen = sys.argv[1:] or list(SPORTS)
    results = []
    for sport in chosen:
        all_games = games(sport)
        rows = model_rows(sport, all_games)
        print(sport, len(all_games), 'games,', sum(1 for g in all_games if g.get('open_total') is not None), 'with lines', flush=True)
        results += evaluate(sport, rows)
    write(results)
    for e in results:
        print(e)
