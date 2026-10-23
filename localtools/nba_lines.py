"""Opening and closing lines per NBA game (ESPN's core odds feed: DraftKings when listed,
else the first book), cached in data/nba/lines/. For line-movement research.

Run: python nba_lines.py   (fills the cache, 6 games at a time)
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import nba_data
import nba_extra

CACHE = nba_data.CACHE / 'lines'


def _american(node: dict | None, key: str):
    try:
        text = ((node or {}).get(key) or {}).get('american')
        return float(str(text).replace('+', '')) if text not in (None, '', 'OFF', 'EVEN') else (100.0 if text == 'EVEN' else None)
    except ValueError:
        return None


def moves(game_id: str, http=None) -> dict:
    def fetch():
        if http is None:
            import requests
            get = requests.get
        else:
            get = http
        items = get(nba_extra.CORE.format(game_id), timeout=30).json().get('items', [])
        if not items:
            return {}
        p = next((i for i in items if 'draftkings' in (i.get('provider') or {}).get('name', '').lower()), items[0])
        home, away = p.get('homeTeamOdds') or {}, p.get('awayTeamOdds') or {}
        out = {'provider': (p.get('provider') or {}).get('name')}
        for when in ('open', 'close'):
            top = p.get(when) or {}
            out[f'{when}_total'] = _american(top, 'total')
            out[f'{when}_over_odds'] = _american(top, 'over')
            out[f'{when}_under_odds'] = _american(top, 'under')
            out[f'{when}_home_spread'] = _american(home.get(when), 'pointSpread')
            out[f'{when}_home_spread_odds'] = _american(home.get(when), 'spread')
            out[f'{when}_away_spread_odds'] = _american(away.get(when), 'spread')
            out[f'{when}_home_ml'] = _american(home.get(when), 'moneyLine')
            out[f'{when}_away_ml'] = _american(away.get(when), 'moneyLine')
        # Totals can come as "o228.5"/"u228.5" strings.
        for when in ('open', 'close'):
            if out[f'{when}_total'] is None:
                raw = (((p.get(when) or {}).get('total') or {}).get('alternateDisplayValue') or '').lstrip('ou')
                try:
                    out[f'{when}_total'] = float(raw)
                except ValueError:
                    pass
        return out
    return nba_data._cached(CACHE / f'{game_id}.json.gz', fetch)


def fill(log=print) -> dict:
    ids = []
    for _, start, end in nba_data.SEASONS:
        day, last = date.fromisoformat(start), min(date.fromisoformat(end), date.today() - timedelta(days=1))
        while day <= last:
            ids += [g['id'] for g in nba_data.games_on(day) if g['final']]
            day += timedelta(days=1)

    def one(game_id):
        try:
            return 'ok' if moves(game_id).get('close_total') else 'empty'
        except Exception:
            return 'error'
    counts = {}
    with ThreadPoolExecutor(6) as pool:
        for result in pool.map(one, ids):
            counts[result] = counts.get(result, 0) + 1
    return counts


if __name__ == '__main__':
    started = time.time()
    print(fill(), f'{time.time() - started:.0f}s')
    print(moves('401810500'))
