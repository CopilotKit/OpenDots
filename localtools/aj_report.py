"""What AJ says about the trading and betting: the whole picture in a few spoken
sentences, and the problems worth interrupting the owner for.

AJ (the owner's voice assistant, AIVoice/Jvis) reaches this through OpenDots'
/api/aj routes. Spoken text is plain sentences: no tables, symbols or lists,
because every word of it is read aloud at $0.05 a minute.

Run: python aj_report.py report
     python aj_report.py problems SINCE   (SINCE: unix seconds)
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path

ALERTS = Path(__file__).resolve().parent.parent / 'data' / 'options-alerts.jsonl'
# Alerts that only say a paper record moved; the rest ask the owner to act.
INFORMATIONAL = {'paper pick', 'shadow pick', 'daily report', 'nba totals', 'NHL spreads', 'NFL spreads'}
# Scheduled-task results that are not failures: 267009 running, 267011 not run yet.
JOB_OK = {0, 267009, 267011, None}


def dollars(value) -> str:
    value = float(value or 0)
    sign = 'minus ' if value < 0 else ''
    return f'{sign}${abs(value):,.2f}'.replace('.00', '')


def day(text: str) -> str:
    """'2026-10-30' -> 'October 30'."""
    try:
        d = datetime.strptime(text[:10], '%Y-%m-%d')
        return f'{d:%B} {d.day}'
    except ValueError:
        return text


def options_speech(o: dict) -> list[str]:
    if o.get('error'):
        return ['The options records could not be read.']
    out = []
    weekly = o.get('weekly_puts') or {}
    pick = weekly.get('open')
    if pick:
        out.append(f'One weekly put spread is open on paper: the {pick["short"]:g} over {pick["long"]:g} put, '
                   f'expiring {day(pick["expiry"])}, sold for {dollars(pick["credit"])}.')
    if weekly.get('trades'):
        out.append(f'The weekly put spreads have closed {weekly["trades"]}, won {weekly["wins"]}, '
                   f'for {dollars(weekly["profit"])} on paper.')
    elif not pick:
        out.append('No weekly put spread is open; one starts at a close above the 200-day average.')
    on = [f'{name} on {t}' for t, e in (o.get('edges') or {}).items() if isinstance(e, dict)
          for name, flag in (('fading fear', e.get('fading_fear')), ('stretched calls', e.get('stretched'))) if flag]
    picks = o.get('picks') or []
    closed = [p for p in picks if p.get('how') != 'still open' and p.get('pnl') is not None]
    shadow = (f'The two options edges are on: {", ".join(on)}.' if on else 'Neither options edge is on today.')
    if closed:
        shadow += (f' Their picks over 30 days: {sum(p["pnl"] > 0 for p in closed)} of {len(closed)} won, '
                   f'{dollars(sum(p["pnl"] for p in closed))}.')
    out.append(shadow)
    mode = (o.get('autopilot') or {}).get('mode', 'off')
    if mode != 'off':
        out.append(f'The options autopilot is in {mode.replace("_", " ")} mode.')
    return out


def sports_speech(s: dict) -> list[str]:
    if s.get('error'):
        return ['The betting records could not be read.']
    out = []
    edges = s.get('paper_edges') or {}
    for name, e in edges.items():
        if not isinstance(e, dict):
            continue
        settled, open_ = e.get('bets') or 0, e.get('open') or 0
        label = {'NFL': 'NFL spreads', 'NHL': 'NHL puck lines'}.get(name, name)
        if settled:
            wins = round((e.get('win_rate') or 0) * settled)
            out.append(f'{label}: {wins} won of {settled} settled, {dollars(e.get("profit"))} on paper'
                       + (f', {open_} still open.' if open_ else '.'))
        elif open_:
            out.append(f'{label}: {open_} open, none settled yet.')
    parlays = s.get('parlays') or 0
    out.append(f'NBA props parlays: {parlays} so far, {dollars(s.get("profit"))}.' if parlays
               else 'No NBA props parlays have qualified yet.')
    out.append('No real bets have been placed.' if not s.get('real_bets_placed') else
               f'{s["real_bets_placed"]} real bets have been placed.')
    return out


def pocket_speech(p: dict) -> list[str]:
    if p.get('error'):
        return ['The Pocket Option record could not be read.']
    d, a = p.get('day') or {}, p.get('all') or {}
    if d.get('trades'):
        return [f'Pocket Option in the last day: {d["trades"]} trades, {d["wins"]} won, {dollars(d["profit"])}.']
    if a.get('trades'):
        return [f'No Pocket Option trades in the last day. All time: {a["trades"]} trades at '
                f'{round((a.get("win_rate") or 0) * 100)} percent, {dollars(a["profit"])}.']
    return []


def report(board: dict) -> dict:
    """{'speech': a few sentences for AJ to say, 'details': the numbers behind them}."""
    problems = job_problems(board.get('jobs') or [], 0)
    parts = (options_speech(board.get('options') or {}) + sports_speech(board.get('sports') or {})
             + pocket_speech(board.get('pocket') or {}))
    parts.append(f'{len(problems)} scheduled job{"s" if len(problems) != 1 else ""} failed on its last run.'
                 if problems else 'All scheduled jobs ran cleanly.')
    return {'speech': ' '.join(parts), 'details': board, 'at': time.time()}


def job_time(text: str) -> float:
    try:
        return datetime.strptime(text, '%Y-%m-%d %H:%M').timestamp()
    except (TypeError, ValueError):
        return 0.0


def job_problems(jobs: list, since: float) -> list[dict]:
    out = []
    for j in jobs if isinstance(jobs, list) else []:
        at = job_time(j.get('last'))
        if j.get('result') not in JOB_OK and at >= since:
            name = str(j.get('name', '')).replace('OpenDots ', '')
            out.append({'at': at, 'kind': 'job', 'title': f'{name} failed',
                        'message': f'The scheduled job {name} failed on its last run, at {j.get("last")} '
                                   f'(result code {j.get("result")}).'})
    return out


def alert_problems(since: float, path: Path | None = None) -> list[dict]:
    out = []
    try:
        lines = (path or ALERTS).read_text(encoding='utf-8').splitlines()
    except OSError:
        return out
    for line in lines[-500:]:
        try:
            a = json.loads(line)
        except ValueError:
            continue
        if float(a.get('at') or 0) < since or a.get('event') in INFORMATIONAL:
            continue
        out.append({'at': float(a['at']), 'kind': 'alert', 'title': a.get('title') or a.get('event') or 'Alert',
                    'message': a.get('message') or ''})
    return out


def problems(board: dict, since: float) -> list[dict]:
    """Things to interrupt the owner for, oldest first: failed scheduled jobs, alerts
    that need the owner (an options exit to press, a refused entry), unreadable records."""
    found = job_problems(board.get('jobs') or [], since) + alert_problems(since)
    for name in ('options', 'sports', 'pocket'):
        error = (board.get(name) or {}).get('error')
        if error:
            found.append({'at': time.time(), 'kind': 'record', 'title': f'The {name} record cannot be read',
                          'message': error})
    return sorted(found, key=lambda p: p['at'])


if __name__ == '__main__':
    command = (sys.argv[1:] or ['report'])[0]
    import dashboard
    board = dashboard.build()
    if command == 'problems':
        since = float(sys.argv[2]) if len(sys.argv) > 2 else time.time() - 86400
        print(json.dumps({'problems': problems(board, since)}, default=str))
    else:
        print(json.dumps(report(board), default=str))
