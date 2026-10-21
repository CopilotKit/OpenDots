"""Exit listener for the owner's open options trades (Robinhood has no trailing
stop, and no take profit alongside a stop).

Every 30 seconds while the market is open, each trade recorded as taken
(options_record ... taken) is revalued from the stock's near-real-time 1-minute
price, the same model as options_track, priced from the owner's actual fill.
When an exit fires, the listener sets up the closing order on Robinhood in its
own tab (never a Dot's tab), the Review order button blinks with the mouse on
it, and the owner is told: a Windows notification, and the OpenDots banner on
the phone. The owner presses Review order; nothing here places an order.

Exits, each fired once per trade:
- profit target and stop: the suggestion's own management rules (track()).
- trailing stop: once the trade is up LOCK_START (at least $2, or 10% of what
  was paid or collected), a floor follows it at half the best profit (never
  under $1, after fees). If the profit falls back to the floor, close: a
  winner is never allowed to turn into a loss. The owner prefers a small
  profit on every trade over bigger, rarer wins.
- time exit 3:45pm on expiry day.

Run: python options_watch.py (it stops at 4:05pm New York); a scheduled task
starts it each weekday morning.
"""
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

import options_guide as og

ALERTS = Path(__file__).resolve().parent.parent / 'data' / 'options-alerts.jsonl'
EVERY_S = 30
LOCK_MIN = 2.0       # Dollars of profit before the trailing floor starts...
LOCK_SHARE = 0.10    # ...or this share of the premium, whichever is more.
FLOOR_KEEP = 0.5     # The floor keeps this share of the best profit,
FLOOR_MIN = 1.0      # and never less than this many dollars.


def closing_legs(legs: list) -> list:
    return [{**leg, 'action': 'buy' if leg['action'] == 'sell' else 'sell'} for leg in legs]


def watch(row: dict, bars: list[dict]) -> dict:
    """Where an open trade stands and which exits have fired, from its fill on.
    bars: [{'time': New York datetime, 'price'}] covering the fill to now."""
    data = json.loads(row['data'])
    sign = 1 if data['price'] > 0 else -1
    data = {**data, 'price': sign * abs(row['entry'])}  # The owner's fill, not the suggested price.
    entered = og.eastern(datetime.fromtimestamp(row.get('opened_ts') or row['ts'], timezone.utc))
    result = og.track(data, entered, bars)
    points = result['points']
    lock_at = max(LOCK_MIN, LOCK_SHARE * abs(row['entry']) * 100 * data['qty'])
    events = [{**e, 'mark': next((p['mark'] for p in points if p['time'] == e['time']), None)} for e in result['events']]
    peak, floor = None, None
    for i, p in enumerate(points):
        peak = p['pnl'] if peak is None else max(peak, p['pnl'])
        if peak >= lock_at:
            floor = max(FLOOR_MIN, FLOOR_KEEP * peak)
            if p['pnl'] <= floor and i and not any(e['event'] == 'trailing stop' for e in events):
                bar = [b for b in bars if b['time'] >= entered][i]
                events.append({'event': 'trailing stop', 'time': p['time'], 'day': bar['time'].strftime('%m-%d'),
                               'pnl': p['pnl'], 'mark': p['mark']})
    now = points[-1] if points else {}
    return {'id': row['id'], 'ticker': data['ticker'], 'kind': data['kind'], 'expiry': data['expiry'],
            'legs': data['legs'], 'qty': data['qty'], 'entry': row['entry'], 'credit': sign > 0,
            'now_pnl': now.get('pnl'), 'mark': now.get('mark'), 'price': now.get('price'), 'best_pnl': peak,
            'trailing_floor': floor, 'trailing_starts_at': round(lock_at, 2), 'events': events}


class Alerts:
    """Which exits were already sent, kept in the options journal."""

    def __init__(self, path=og.DB):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS exit_alerts(trade TEXT, event TEXT, ts REAL, data TEXT, PRIMARY KEY(trade, event))')

    def sent(self, trade: str) -> set:
        with closing(sqlite3.connect(self.path)) as db:
            return {r[0] for r in db.execute('SELECT event FROM exit_alerts WHERE trade=?', (trade,))}

    def add(self, trade: str, event: str, data: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT OR IGNORE INTO exit_alerts VALUES(?,?,?,?)', (trade, event, time.time(), json.dumps(data)))


def today_bars(ticker: str) -> list[dict]:
    return [{'time': b['time'], 'price': b['c']} for b in og.yahoo_minutes(ticker, max_age=20)]


def bars_since(journal: og.Journal, row: dict, now: datetime, minutes=today_bars) -> list[dict]:
    opened = og.eastern(datetime.fromtimestamp(row.get('opened_ts') or row['ts'], timezone.utc)).date()
    earlier = journal.load_bars(row['ticker'], opened, now.date() - timedelta(days=1)) if opened < now.date() else []
    return earlier + minutes(row['ticker'])


def notify(alert: dict) -> None:
    """The OpenDots banner (phone and PC) reads the alerts file; Windows shows a toast."""
    ALERTS.parent.mkdir(parents=True, exist_ok=True)
    with ALERTS.open('a', encoding='utf-8') as f:
        f.write(json.dumps(alert) + '\n')
    if os.environ.get('LOCALTOOLS_NO_TOAST'):
        return
    script = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
        "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
        "$t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode($env:DOTS_TITLE)) > $null;"
        "$t.Item(1).AppendChild($x.CreateTextNode($env:DOTS_BODY)) > $null;"
        "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))")
    try:
        subprocess.run(['powershell', '-NoProfile', '-Command', script], timeout=20, capture_output=True,
                       env={**os.environ, 'DOTS_TITLE': alert['title'], 'DOTS_BODY': alert['message']})
    except (OSError, subprocess.SubprocessError):
        pass  # The banner still has it.


async def check(journal: og.Journal, alerts: Alerts, now: datetime, set_up, minutes=today_bars, say=notify) -> list[dict]:
    """One pass over the open trades: send each newly fired exit once.
    set_up(state, legs) sets up the closing order and returns its result."""
    sent = []
    for row in journal.open_trades():
        try:
            state = watch(row, bars_since(journal, row, now, minutes))
        except Exception as error:  # One trade's data problem must not stop the others.
            print(f'{row["id"]}: {error}', file=sys.stderr)
            continue
        done = alerts.sent(row['id'])
        for event in state['events']:
            if event['event'] in done:
                continue
            try:
                ready = await set_up(state, closing_legs(state['legs']))
                setup = {k: ready.get(k) for k in ('result', 'estimate', 'limit', 'bid_ask', 'warning', 'mouse_on')}
            except Exception as error:
                setup = {'result': 'not set up', 'error': f'{type(error).__name__}: {error}'}
            legs = ' / '.join(f'{l["action"]} {l["strike"]:g}{l["type"][0].upper()}' for l in state['legs'])
            alert = {
                'at': time.time(), 'trade': row['id'], 'event': event['event'], 'ticker': state['ticker'],
                'expiry': state['expiry'], 'pnl': event['pnl'], 'now_pnl': state['now_pnl'], 'setup': setup,
                'title': f'Close {state["ticker"]} {state["kind"]}: {event["event"]}',
                'message': (f'{legs} {state["expiry"]}: about ${event["pnl"]:+.2f} at {event["time"]} (model). '
                            + ('The closing order is set up on Robinhood: check the limit and press Review order.'
                               if setup['result'] == 'ready_for_owner' else
                               f'Could not set up the closing order ({setup.get("error", "")[:120]}): close it on Robinhood yourself.'))}
            say(alert)
            alerts.add(row['id'], event['event'], alert)
            sent.append(alert)
            done.add(event['event'])
            break  # One closing order per trade at a time; the next pass sends any later exit.
    return sent


async def main() -> None:
    from playwright.async_api import async_playwright
    import robinhood_ticket
    journal, alerts = og.Journal(), Alerts()
    async with async_playwright() as pw:
        chrome = None
        tab = None

        async def set_up(state, legs):
            nonlocal chrome, tab
            if chrome is None or not chrome.is_connected():
                chrome = await pw.chromium.connect_over_cdp('http://127.0.0.1:9333')
            if tab is None or tab.is_closed():
                # Its own tab in the signed-in browser: a Dot's tab is never taken over.
                context = next((c for c in chrome.contexts if any('robinhood.com' in p.url for p in c.pages)), chrome.contexts[0])
                tab = await context.new_page()
            await tab.bring_to_front()
            # Limit left at Robinhood's live mid: the model price is only the trigger.
            return await robinhood_ticket.set_up(tab, state['ticker'], state['expiry'], legs, state['qty'], None, 'day')

        while True:
            now = og.now_eastern()
            if now.hour * 60 + now.minute >= 16 * 60 + 5:
                break
            if og.market_open(now) and journal.open_trades():
                for alert in await check(journal, alerts, now, set_up):
                    print(json.dumps(alert), flush=True)
            await asyncio.sleep(EVERY_S)


if __name__ == '__main__':
    asyncio.run(main())
