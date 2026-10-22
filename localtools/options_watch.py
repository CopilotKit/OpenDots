"""Exit listener for the owner's open options trades (Robinhood has no trailing
stop, and no take profit alongside a stop).

Every 30 seconds while the market is open, each trade recorded as taken
(options_record ... taken) is revalued from the stock's near-real-time 1-minute
price, the same model as options_track, priced from the owner's actual fill.
When an exit fires, the listener sets up the closing order on Robinhood in its
own tab (never a Dot's tab), the Review order button blinks with the mouse on
it, and the owner is told: a Windows notification, and the OpenDots banner on
the phone. The owner presses Review order, unless the owner turned the
autopilot on (autopilot.py): then it checks the order and presses through
itself (dry run: up to the review screen), and every 5 minutes with no trade
open it also enters the best suggestion that passes every check.

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
from datetime import date, datetime, timedelta, timezone
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
    trails = (data.get('exit') or {}).get('trail', True)  # Edge trades run as tested: no trailing stop.
    for i, p in enumerate(points):
        peak = p['pnl'] if peak is None else max(peak, p['pnl'])
        if trails and peak >= lock_at:
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


def placed_note(placed: dict | None) -> str:
    """What the autopilot did with an order, for the owner."""
    if not placed:
        return ''
    if placed['result'] == 'submitted':
        return f' Autopilot pressed "{placed["pressed"]}". Check the fill on Robinhood.'
    if placed['result'] == 'dry_run':
        return f' Dry run: it stopped at the review screen; submit it yourself if you agree. {" ".join(placed["why"])}'
    return f' Autopilot did not press anything: {" ".join(placed["why"])}'


async def check(journal: og.Journal, alerts: Alerts, now: datetime, set_up, minutes=today_bars, say=notify,
                place=None) -> list[dict]:
    """One pass over the open trades: send each newly fired exit once.
    set_up(state, legs) sets up the closing order and returns its result;
    place(row, state, legs, ready), when the autopilot is on, checks it and
    presses through (autopilot.place), returning what it did."""
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
            placed = None
            try:
                ready = await set_up(state, closing_legs(state['legs']))
                setup = {k: ready.get(k) for k in ('result', 'estimate', 'limit', 'bid_ask', 'warning', 'mouse_on')}
                if place:
                    placed = await place(row, state, closing_legs(state['legs']), ready)
            except Exception as error:
                setup = {'result': 'not set up', 'error': f'{type(error).__name__}: {error}'}
            if placed and placed['result'] == 'submitted':
                journal.record(row['id'], 'closed', setup['limit'])  # At the limit sent; the fill may differ by cents.
            legs = ' / '.join(f'{l["action"]} {l["strike"]:g}{l["type"][0].upper()}' for l in state['legs'])
            submitted = bool(placed and placed['result'] == 'submitted')
            alert = {
                'at': time.time(), 'trade': row['id'], 'event': event['event'], 'ticker': state['ticker'],
                'expiry': state['expiry'], 'pnl': event['pnl'], 'now_pnl': state['now_pnl'], 'setup': setup,
                'autopilot': placed,
                'title': f'{"Closed" if submitted else "Close"} {state["ticker"]} {state["kind"]}: {event["event"]}',
                'message': (f'{legs} {state["expiry"]}: about ${event["pnl"]:+.2f} at {event["time"]} (model).'
                            + (placed_note(placed) if submitted else
                               ' The closing order is set up on Robinhood: check the limit and press Review order.'
                               + placed_note(placed)
                               if setup['result'] == 'ready_for_owner' else
                               f' Could not set up the closing order ({setup.get("error", "")[:120]}): close it on Robinhood yourself.'))}
            say(alert)
            alerts.add(row['id'], event['event'], alert)
            sent.append(alert)
            done.add(event['event'])
            break  # One closing order per trade at a time; the next pass sends any later exit.
    return sent


ENTRY_EVERY_S = 300
# What the autopilot trades: the edge finder's two edges (2026-10-21), so the dry run builds
# their record. The other kinds stay suggestions for the owner.
AUTOPILOT_KINDS = 'edge'
PRICE_SLIP = 0.10  # An entry's live mid may be at most 10% worse than the suggestion's.


def bars_for(journal: og.Journal, ticker: str, start, now: datetime, minutes=today_bars) -> list[dict]:
    """Saved minute prices from `start` to now, with today's live ones if not saved yet."""
    bars = journal.load_bars(ticker, start, now.date())
    if not any(b['time'].date() == now.date() for b in bars):
        try:
            bars += minutes(ticker)
        except Exception:
            pass  # Price data down: scored with what is saved.
    return bars


def pick_results(journal: og.Journal, orders, now: datetime, days: int = 30, minutes=today_bars) -> dict:
    """How each autopilot pick did (live) or would have done (dry run): replayed
    from the price it used, managed by its rules (profit target, stop, 3:45pm on
    expiry day; trailing stop as the listener runs it), per pick and per day."""
    picks = []
    for order in orders.entries(days):
        rows = journal._rows('id=?', (order['trade'],))
        if not rows:
            continue
        data = json.loads(rows[0]['data'])
        limit = order['detail'].get('limit') or abs(data['price'])
        entered = og.eastern(datetime.fromtimestamp(order['ts'], timezone.utc))
        state = watch({'id': order['trade'], 'ts': order['ts'], 'opened_ts': order['ts'], 'entry': limit,
                       'data': json.dumps(data)}, bars_for(journal, data['ticker'], entered.date(), now, minutes))
        exit_ = state['events'][0] if state['events'] else None
        expired = now.date() > date.fromisoformat(data['expiry']) or (
            now.date() == date.fromisoformat(data['expiry']) and now.hour >= 16)
        picks.append({'day': order['day'], 'time': entered.strftime('%H:%M'), 'trade': order['trade'],
                      'mode': order['mode'], 'kind': data['kind'], 'ticker': data['ticker'], 'expiry': data['expiry'],
                      'price': limit, 'pnl': exit_['pnl'] if exit_ else state['now_pnl'],
                      'how': (exit_['event'] if exit_ else 'held to expiry' if expired else 'still open'),
                      'closed_at': exit_['time'] if exit_ else None,
                      'closed_day': (f'{data["expiry"][:4]}-{exit_["day"]}' if exit_ else
                                     data['expiry'] if expired else None)})
    days_out: dict = {}
    for p in picks:
        d = days_out.setdefault(p['day'], {'day': p['day'], 'picks': 0, 'wins': 0, 'pnl': 0.0, 'open': 0})
        d['picks'] += 1
        if p['how'] == 'still open':
            d['open'] += 1
        elif p['pnl'] is not None:
            d['wins'] += p['pnl'] > 0
            d['pnl'] = round(d['pnl'] + p['pnl'], 2)
    return {'picks': picks[::-1], 'days': sorted(days_out.values(), key=lambda d: d['day'], reverse=True),
            'note': 'Replayed from each pick\'s price with the stock\'s minute prices (a model of the option '
                    'prices; real fills differ by cents).'}


async def enter(journal: og.Journal, orders, et: datetime, find, set_up, place, say=notify,
                minutes=today_bars) -> dict | None:
    """Autopilot entries: the best suggestion that passes every check is set up
    at the live mid and placed (dry run: stopped at the review). One per pass."""
    import autopilot
    mode = autopilot.state()['mode']
    if journal.open_trades():
        return None
    if mode != 'live':
        # One trade at a time, as live: the last pick must have closed (by its rules) first.
        last = pick_results(journal, orders, et, 14, minutes)['picks']
        if last and last[0]['how'] == 'still open':
            return None
    tried = orders.refused_since(time.time() - 1800)  # A refused suggestion waits half an hour.
    for suggestion in find():
        if suggestion.get('id') in tried:
            continue
        problems = autopilot.check_entry(journal, orders, suggestion, 'dry_run' if mode == 'off' else mode, et)
        if problems:
            continue
        if mode == 'off':
            # Shadow record: the autopilot is off, so nothing is opened or pressed. The pick is
            # logged at the suggestion's mid (Cboe, ~15 minutes delayed) and scored like a dry run.
            legs = ' / '.join(f'{l["action"]} {l["strike"]:g}{l["type"][0].upper()}' for l in suggestion['legs'])
            orders.add(suggestion['id'], 'entry', 'shadow', 'shadow',
                       {'legs': suggestion['legs'], 'qty': suggestion['qty'], 'limit': suggestion['limit']})
            say({'at': time.time(), 'trade': suggestion['id'], 'event': 'shadow pick', 'ticker': suggestion['ticker'],
                 'title': f'Shadow pick: {suggestion["ticker"]} {suggestion["kind"]}',
                 'message': f'{legs} {suggestion["expiry"]} at about ${suggestion["limit"]:.2f}. Recorded only '
                            '(autopilot off): scored at 4:15pm with the rest.'})
            return {'result': 'shadow', 'trade': suggestion['id']}
        ready = await set_up(suggestion)
        credit = suggestion['price'] > 0
        planned = suggestion.get('limit', abs(suggestion['price']))
        worse = ready['limit'] < planned * (1 - PRICE_SLIP) if credit else ready['limit'] > planned * (1 + PRICE_SLIP)
        extra = [f'The live mid ${ready["limit"]:.2f} is more than {PRICE_SLIP:.0%} worse than planned ${planned:.2f}.'] if worse else []
        placed = await place(suggestion, ready, extra, autopilot.title_for(suggestion['legs'], credit))
        if placed['result'] == 'submitted':
            journal.record(suggestion['id'], 'taken', ready['limit'])  # At the limit sent; the listener manages it from here.
        legs = ' / '.join(f'{l["action"]} {l["strike"]:g}{l["type"][0].upper()}' for l in suggestion['legs'])
        say({'at': time.time(), 'trade': suggestion['id'], 'event': f'autopilot entry ({placed["result"]})',
             'ticker': suggestion['ticker'], 'autopilot': placed,
             'title': f'{"Opened" if placed["result"] == "submitted" else "Autopilot"} {suggestion["ticker"]} {suggestion["kind"]}',
             'message': f'{legs} {suggestion["expiry"]} at ${ready["limit"]:.2f}.' + placed_note(placed)})
        return placed
    return None


async def main() -> None:
    from playwright.async_api import async_playwright
    import autopilot
    import robinhood_ticket
    journal, alerts, orders = og.Journal(), Alerts(), autopilot.Orders()
    async with async_playwright() as pw:
        chrome = None
        tab = None

        async def page():
            nonlocal chrome, tab
            if chrome is None or not chrome.is_connected():
                chrome = await pw.chromium.connect_over_cdp('http://127.0.0.1:9333')
            if tab is None or tab.is_closed():
                # Its own tab in the signed-in browser: a Dot's tab is never taken over.
                context = next((c for c in chrome.contexts if any('robinhood.com' in p.url for p in c.pages)), chrome.contexts[0])
                tab = await context.new_page()
            await tab.bring_to_front()
            return tab

        async def set_up(state, legs):
            # The model price is only the trigger. For the owner: the live mid. For the
            # autopilot: the side that fills (pay the ask to close a credit, take the bid
            # to close a debit), so a stop is not left unfilled.
            at = None if autopilot.state()['mode'] == 'off' else ('ask' if state['credit'] else 'bid')
            return await robinhood_ticket.set_up(await page(), state['ticker'], state['expiry'], legs, state['qty'],
                                                 None, 'day', at=at)

        async def place_exit(row, state, legs, ready):
            if autopilot.state()['mode'] == 'off':
                return None
            problems = autopilot.check_exit(journal, row['id'], legs, state['qty'])
            return await autopilot.place(await page(), 'exit', row['id'], legs, state['qty'], ready['limit'], None,
                                         orders, problems)

        async def set_up_entry(s):
            return await robinhood_ticket.set_up(await page(), s['ticker'], s['expiry'], s['legs'], s['qty'], None, 'day')

        async def place_entry(s, ready, extra, title):
            return await autopilot.place(await page(), 'entry', s['id'], s['legs'], s['qty'], ready['limit'],
                                         autopilot.max_loss_allowed(s['kind']), orders, extra, title)

        def find():
            return og.suggest(journal, kinds=AUTOPILOT_KINDS).get('suggestions', [])

        last_entry = 0.0
        while True:
            now = og.now_eastern()
            if now.hour * 60 + now.minute >= 16 * 60 + 5:
                break
            if og.market_open(now):
                try:
                    if journal.open_trades():
                        for alert in await check(journal, alerts, now, set_up, place=place_exit):
                            print(json.dumps(alert), flush=True)
                    elif time.time() - last_entry >= ENTRY_EVERY_S:
                        last_entry = time.time()
                        placed = await enter(journal, orders, now, find, set_up_entry, place_entry)
                        if placed:
                            print(json.dumps(placed), flush=True)
                except Exception as error:  # A bad pass must not end the day's watching.
                    print(f'pass failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            await asyncio.sleep(EVERY_S)


if __name__ == '__main__':
    asyncio.run(main())
