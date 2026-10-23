"""Fills nba_extra's cache quickly: 6 games at a time, with the core-feed line where the
summary has none. Run: python nba_extra_fill.py"""
import gzip
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import nba_data
import nba_extra


def one(game_id: str) -> str:
    path = nba_extra.CACHE / f'{game_id}.json.gz'
    try:
        game = nba_extra.extra(game_id)
        if not game['line'].get('total') and not game.get('core_checked'):
            game = nba_extra.fill_line(game)
            if not game['line'].get('total'):
                game['core_checked'] = True
                path.write_bytes(gzip.compress(json.dumps(game).encode()))
        return 'line' if game['line'].get('total') else 'no line'
    except Exception as error:
        return f'error {error}'[:80]


ids = []
for _, start, end in nba_data.SEASONS:
    day, last = date.fromisoformat(start), min(date.fromisoformat(end), date.today() - timedelta(days=1))
    while day <= last:
        ids += [g['id'] for g in nba_data.games_on(day) if g['final']]
        day += timedelta(days=1)
started = time.time()
counts = {}
with ThreadPoolExecutor(6) as pool:
    for k, result in enumerate(pool.map(one, ids), 1):
        counts[result.split(' ')[0]] = counts.get(result.split(' ')[0], 0) + 1
        if k % 200 == 0:
            print(k, 'of', len(ids), counts, f'{time.time() - started:.0f}s', flush=True)
print('done', len(ids), counts, f'{time.time() - started:.0f}s')
