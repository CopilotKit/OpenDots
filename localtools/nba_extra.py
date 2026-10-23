"""More per game from ESPN's summary than nba_data keeps: DraftKings' game lines
(spread, total, moneylines, as ESPN's pick center shows them), team totals for pace
(shots, free throws, offensive rebounds, turnovers), fuller player lines (3-pointers,
turnovers, +/-) and the game's injury list. Cached in data/nba/extra/.

Run: python nba_extra.py   (fills the cache for every finished game nba_data knows)
"""
from __future__ import annotations

import time
from datetime import date, timedelta

import nba_data

CACHE = nba_data.CACHE / 'extra'


def _num(text, default=0.0):
    try:
        return float(str(text).split('-')[0]) if text not in (None, '', '--') else default
    except ValueError:
        return default


def _pair(text):
    try:
        made, tried = str(text).split('-')
        return float(made), float(tried)
    except ValueError:
        return 0.0, 0.0


def extra(game_id: str, http=None) -> dict:
    def fetch():
        s = nba_data._get('summary', {'event': game_id}, http)
        competitors = s['header']['competitions'][0]['competitors']
        side = {c['team']['id']: c['homeAway'] for c in competitors}
        names = {c['team']['id']: c['team']['displayName'] for c in competitors}
        score = {c['homeAway']: _num(c.get('score')) for c in competitors}
        teams = {}
        for t in s['boxscore']['teams']:
            stats = {x['name']: x.get('displayValue') for x in t['statistics']}
            fgm, fga = _pair(stats.get('fieldGoalsMade-fieldGoalsAttempted'))
            tpm, tpa = _pair(stats.get('threePointFieldGoalsMade-threePointFieldGoalsAttempted'))
            ftm, fta = _pair(stats.get('freeThrowsMade-freeThrowsAttempted'))
            teams[side[t['team']['id']]] = {'team': names[t['team']['id']], 'fga': fga, 'fgm': fgm, 'tpa': tpa, 'tpm': tpm,
                                            'fta': fta, 'ftm': ftm, 'oreb': _num(stats.get('offensiveRebounds')),
                                            'tov': _num(stats.get('totalTurnovers') or stats.get('turnovers'))}
        players = []
        for t in s['boxscore']['players']:
            block = t['statistics'][0]
            for a in block['athletes']:
                if a.get('didNotPlay') or not a.get('stats'):
                    continue
                row = dict(zip(block['labels'], a['stats']))
                players.append({'player': a['athlete']['displayName'], 'side': side[t['team']['id']],
                                'tpa': _pair(row.get('3PT'))[1], 'tpm': _pair(row.get('3PT'))[0],
                                'fgm': _pair(row.get('FG'))[0], 'ftm': _pair(row.get('FT'))[0],
                                'tov': _num(row.get('TO')), 'oreb': _num(row.get('OREB')), 'reb': _num(row.get('REB')),
                                'ast': _num(row.get('AST')), 'plus_minus': _num(str(row.get('+/-', '0')).replace('+', ''))})
        line = {}
        for p in s.get('pickcenter') or []:
            if 'draftkings' in (p.get('provider', {}).get('name', '').lower()) or not line:
                home_fav = bool((p.get('homeTeamOdds') or {}).get('favorite'))
                spread = p.get('spread')
                line = {'provider': p.get('provider', {}).get('name'), 'total': p.get('overUnder'),
                        'home_spread': (-abs(spread) if home_fav else abs(spread)) if spread is not None else None,
                        'over_odds': p.get('overOdds'), 'under_odds': p.get('underOdds'),
                        'home_ml': (p.get('homeTeamOdds') or {}).get('moneyLine'),
                        'away_ml': (p.get('awayTeamOdds') or {}).get('moneyLine'),
                        'home_spread_odds': (p.get('homeTeamOdds') or {}).get('spreadOdds'),
                        'away_spread_odds': (p.get('awayTeamOdds') or {}).get('spreadOdds')}
        out_list = []
        for team in s.get('injuries') or []:
            for item in team.get('injuries', []):
                out_list.append({'player': (item.get('athlete') or {}).get('displayName'), 'status': item.get('status'),
                                 'team': (team.get('team') or {}).get('displayName')})
        return {'id': game_id, 'home': names[[k for k, v in side.items() if v == 'home'][0]],
                'away': names[[k for k, v in side.items() if v == 'away'][0]], 'score': score, 'teams': teams,
                'players': players, 'line': line, 'injuries': out_list}
    return nba_data._cached(CACHE / f'{game_id}.json.gz', fetch)


CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{0}/competitions/{0}/odds'


def core_line(game_id: str, http=None) -> dict:
    """The game's line from ESPN's core odds feed (has early-season games the summary's pick
    center lacks): DraftKings if listed, else the first book (ESPN BET)."""
    if http is None:
        import requests
        http = requests.get
    items = http(CORE.format(game_id), timeout=30).json().get('items', [])
    if not items:
        return {}
    p = next((i for i in items if 'draftkings' in (i.get('provider') or {}).get('name', '').lower()), items[0])
    home, away = p.get('homeTeamOdds') or {}, p.get('awayTeamOdds') or {}
    spread = p.get('spread')
    return {'provider': (p.get('provider') or {}).get('name'), 'total': p.get('overUnder'),
            'home_spread': (-abs(spread) if home.get('favorite') else abs(spread)) if spread is not None else None,
            'over_odds': p.get('overOdds'), 'under_odds': p.get('underOdds'),
            'home_ml': home.get('moneyLine'), 'away_ml': away.get('moneyLine'),
            'home_spread_odds': home.get('spreadOdds'), 'away_spread_odds': away.get('spreadOdds')}


def fill_line(game: dict, http=None) -> dict:
    """A cached game without a line gets one from the core feed (saved back to the cache)."""
    if game['line'].get('total'):
        return game
    line = core_line(game['id'], http)
    if line.get('total'):
        game = {**game, 'line': line}
        import gzip
        import json
        (CACHE / f'{game["id"]}.json.gz').write_bytes(gzip.compress(json.dumps(game).encode()))
    return game


def load_all(log=print, pause: float = 0.12) -> list[dict]:
    """Every finished game's extra data with its date, oldest first."""
    out, fetched = [], 0
    for _, start, end in nba_data.SEASONS:
        day, last = date.fromisoformat(start), min(date.fromisoformat(end), date.today() - timedelta(days=1))
        while day <= last:
            for g in nba_data.games_on(day):
                if not g['final']:
                    continue
                cached = (CACHE / f'{g["id"]}.json.gz').exists()
                try:
                    game = extra(g['id'])
                    if not game['line'].get('total') and not game.get('core_checked'):
                        game = fill_line(game)
                        if not game['line'].get('total'):  # Remember the feed had none, so it is not asked again.
                            game['core_checked'] = True
                            import gzip
                            import json
                            (CACHE / f'{g["id"]}.json.gz').write_bytes(gzip.compress(json.dumps(game).encode()))
                        time.sleep(pause)
                    out.append({**game, 'date': day.isoformat()})
                except Exception as error:  # One bad summary must not stop the rest.
                    log(f'{g["id"]}: {error}')
                    continue
                if not cached:
                    fetched += 1
                    time.sleep(pause)
                    if fetched % 100 == 0:
                        log(f'{fetched} downloaded (at {day})')
            day += timedelta(days=1)
    return out


if __name__ == '__main__':
    games = load_all()
    with_lines = sum(1 for g in games if g['line'].get('total'))
    print(f'{len(games)} games, {with_lines} with DraftKings lines')
