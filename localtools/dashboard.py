"""The OpenDots dashboard's data: one summary of every scan and paper record.

Sections (each on its own, so one broken source cannot blank the page):
- options: today's two edge conditions (SPY, QQQ), the autopilot state, its picks
  (live, dry run or shadow) per day, the weekly put spread paper record, and the
  suggestion journal by kind;
- sports: the DraftKings paper parlays and their record, Odds API credits;
- quotes: the option quote recorder and the scalp simulator's progress;
- pocket: the Pocket Option demo Trader's record (all, last 24 hours, by source);
- jobs: the scheduled tasks, when each last ran and runs next.

Printed as JSON; the app's GET /api/dashboard runs this.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))


def section(build):
    try:
        return build()
    except Exception as error:  # Shown on its card instead of the numbers.
        return {'error': f'{type(error).__name__}: {error}'[:300]}


def options() -> dict:
    import autopilot
    import options_guide as og
    import options_watch
    edges = {}
    for ticker in ('SPY', 'QQQ'):
        try:
            chain = og.parse_chain(og.fetch(f'options/{ticker}.json'))
            c = og.edge_conditions(ticker, chain)
            edges[ticker] = {**c, 'price': chain['price'],
                             'fading_fear': c['vix_vs_20d'] < -0.0474, 'stretched': c['ma20_z'] >= 1.38}
        except Exception as error:
            edges[ticker] = {'error': str(error)[:200]}
    journal = og.Journal()
    picks = options_watch.pick_results(journal, autopilot.Orders(journal.path), og.now_eastern(), days=30)
    import weekly_puts
    return {'edges': edges, 'autopilot': autopilot.state(), 'record': autopilot.record(journal),
            'weekly_puts': weekly_puts.Record(journal.path).summary(),
            'picks': picks['picks'][:12], 'days': picks['days'][:14], 'by_kind': journal.summary(),
            'market_open': og.market_open(og.now_eastern())}


def sports() -> dict:
    import sports_picks as sp
    journal = sp.Journal()
    recent = [{'id': r['id'], 'day': r['day'], 'status': r['status'], 'payout': r['payout'], 'hit': r['data']['hit'],
               'price': r['data']['price'], 'legs': [sp.describe(l) for l in r['data']['legs']]}
              for r in journal.rows()[-8:]][::-1]
    snapshots = sorted((ROOT / 'data' / 'sports-odds').glob('*/props-*.json.gz'))
    import line_paper
    import nba_totals
    edges = {'NBA totals': nba_totals.Bets().summary(), **line_paper.Bets().summary()}
    return {**journal.summary(), 'recent': recent, 'credits_left': sp.credits_left(), 'paper_edges': edges,
            'last_scan': time.strftime('%Y-%m-%d %H:%M', time.localtime(snapshots[-1].stat().st_mtime)) if snapshots else None,
            'games_scanned': len({p.name.split('-')[1] for p in snapshots})}


def quotes() -> dict:
    import option_quotes
    status = option_quotes.Store().status()
    note = ROOT.parent.parent / 'MainAINotes' / 'Site Maps' / 'Robinhood' / 'Scalp Sim.md'
    return {**status, 'scalp_note_updated': time.strftime('%Y-%m-%d %H:%M', time.localtime(note.stat().st_mtime)) if note.exists() else None}


def pocket() -> dict:
    with closing(sqlite3.connect(ROOT / 'data' / 'trade-journal.sqlite')) as db:
        def stats(where: str = '1=1', args=()):
            row = db.execute(f"SELECT COUNT(*), SUM(result='win'), SUM(result='loss'), ROUND(COALESCE(SUM(profit), 0), 2), "
                             f"MAX(entry_ts) FROM trades WHERE result IN ('win', 'loss') AND {where}", args).fetchone()
            n, wins, losses, profit, last = row
            return {'trades': n or 0, 'wins': wins or 0, 'losses': losses or 0, 'profit': profit or 0.0,
                    'win_rate': round((wins or 0) / n, 3) if n else None, 'last': last}
        by_source = {s: stats('source=?', (s,)) for (s,) in db.execute('SELECT DISTINCT source FROM trades')}
        return {'all': stats(), 'day': stats('entry_ts >= ?', (time.time() - 86400,)), 'by_source': by_source}


def jobs() -> list[dict]:
    script = ("Get-ScheduledTask | Where-Object { $_.TaskName -like 'OpenDots*' } | ForEach-Object { "
              "$i = Get-ScheduledTaskInfo -TaskName $_.TaskName; [pscustomobject]@{ name = $_.TaskName; state = [string]$_.State; "
              "last = $i.LastRunTime.ToString('yyyy-MM-dd HH:mm'); next = $i.NextRunTime.ToString('yyyy-MM-dd HH:mm'); "
              "result = $i.LastTaskResult } } | ConvertTo-Json")
    out = subprocess.run(['powershell', '-NoProfile', '-Command', script], capture_output=True, text=True, timeout=30).stdout
    data = json.loads(out or '[]')
    return data if isinstance(data, list) else [data]


def build() -> dict:
    return {'at': time.time(), 'options': section(options), 'sports': section(sports), 'quotes': section(quotes),
            'pocket': section(pocket), 'jobs': section(jobs)}


if __name__ == '__main__':
    print(json.dumps(build(), default=str))
