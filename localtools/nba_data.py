"""NBA box scores from ESPN's free site API, cached on disk.

Every game's player lines (minutes, points, shots, starter) for last season and
this one; downloaded once, then only new days. Used by nba_props.py.

Run: python nba_data.py   (fills the cache; ~1,300 games the first time)
"""
from __future__ import annotations

import gzip
import json
import time
from datetime import date, timedelta
from pathlib import Path

BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
CACHE = Path(__file__).resolve().parent.parent / 'data' / 'nba'
SEASONS = (('2025-26', '2025-10-21', '2026-04-12'), ('2026-27', '2026-10-20', '2027-04-11'))


def _get(path: str, params: dict, http=None) -> dict:
    if http is None:
        import requests
        http = requests.get
    for attempt in range(3):
        try:
            response = http(f'{BASE}/{path}', params=params, timeout=30)
            response.raise_for_status()
            return response.json()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 + 3 * attempt)


def _cached(path: Path, fetch, keep: bool = True):
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    value = fetch()
    if keep:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(json.dumps(value).encode()))
    return value


def games_on(day: date, http=None) -> list[dict]:
    """[{'id', 'home', 'away', 'final', 'start'}] for a day (finished days are cached)."""
    def fetch():
        events = _get('scoreboard', {'dates': day.strftime('%Y%m%d')}, http).get('events', [])
        out = []
        for e in events:
            teams = {c['homeAway']: c['team']['displayName'] for c in e['competitions'][0]['competitors']}
            out.append({'id': e['id'], 'home': teams.get('home'), 'away': teams.get('away'), 'start': e['date'],
                        'final': e['status']['type'].get('completed', False)})
        return out
    path = CACHE / 'days' / f'{day.isoformat()}.json.gz'
    if path.exists():
        return _cached(path, fetch)
    games = fetch()
    if day < date.today() and all(g['final'] for g in games):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(json.dumps(games).encode()))
    return games


def box(game_id: str, http=None) -> list[dict]:
    """Player lines of a finished game: [{'player', 'id', 'team', 'opponent', 'home', 'min', 'pts',
    'fga', 'fta', 'starter'}] (players who did not play are left out)."""
    def fetch():
        summary = _get('summary', {'event': game_id}, http)
        teams = summary['boxscore']['players']
        names = [t['team']['displayName'] for t in teams]
        home = next((c['team']['displayName'] for c in summary['header']['competitions'][0]['competitors']
                     if c['homeAway'] == 'home'), None)
        rows = []
        for k, team in enumerate(teams):
            block = team['statistics'][0]
            labels = block['labels']
            for a in block['athletes']:
                if a.get('didNotPlay') or not a.get('stats'):
                    continue
                s = dict(zip(labels, a['stats']))
                try:
                    minutes = float(s.get('MIN') or 0)
                except ValueError:
                    continue
                if minutes <= 0:
                    continue
                fga = int(str(s.get('FG', '0-0')).split('-')[1] or 0)
                fta = int(str(s.get('FT', '0-0')).split('-')[1] or 0)
                rows.append({'player': a['athlete']['displayName'], 'id': a['athlete']['id'], 'team': names[k],
                             'opponent': names[1 - k], 'home': names[k] == home, 'min': minutes, 'pts': int(s.get('PTS') or 0),
                             'fga': fga, 'fta': fta, 'starter': bool(a.get('starter'))})
        return rows
    return _cached(CACHE / 'box' / f'{game_id}.json.gz', fetch)


def injuries(http=None) -> dict[str, str]:
    """{player name: status} from ESPN's injury report (Out, Doubtful, Questionable, Day-To-Day)."""
    out = {}
    for team in _get('injuries', {}, http).get('injuries', []):
        for item in team.get('injuries', []):
            name = (item.get('athlete') or {}).get('displayName')
            if name:
                out[name] = item.get('status', '')
    return out


def load(until: date | None = None, log=print, pause: float = 0.15) -> list[dict]:
    """Every player line from the seasons' start to `until` (exclusive), oldest first,
    each with its 'date'. Downloads what is not cached yet."""
    until = until or date.today()
    rows, fetched = [], 0
    for _, start, end in SEASONS:
        day, last = date.fromisoformat(start), min(date.fromisoformat(end), until - timedelta(days=1))
        while day <= last:
            for g in games_on(day):
                if not g['final']:
                    continue
                cached = (CACHE / 'box' / f'{g["id"]}.json.gz').exists()
                for r in box(g['id']):
                    rows.append({**r, 'date': day.isoformat(), 'game': g['id']})
                if not cached:
                    fetched += 1
                    time.sleep(pause)
                    if fetched % 100 == 0:
                        log(f'{fetched} box scores downloaded (at {day})')
            day += timedelta(days=1)
    return rows


if __name__ == '__main__':
    lines = load()
    print(f'{len(lines)} player lines, {len({r["game"] for r in lines})} games, '
          f'{lines[0]["date"] if lines else "-"} to {lines[-1]["date"] if lines else "-"}')
