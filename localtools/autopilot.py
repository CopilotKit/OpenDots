"""Autopilot: the options strategy places and closes its own Robinhood orders
while the owner is away.

Only the owner turns it on, with a PIN typed into the app's Autopilot button
(the PIN is set once from a terminal: `python localtools/autopilot.py set-pin`).
The PIN, the signing key and the on/off state live in C:\\ProgramData\\OpenDots\\autopilot,
outside the folders the Dots' file tools reach, and the state is signed: an
edited state file reads as off. It turns itself off at 4pm New York. Turning
it off needs no PIN.

Modes:
- dry_run: everything up to the final submit (set-up, checks, Review order),
  then stops and logs what it would have submitted. No minimum record needed.
- live: also presses submit, but only for trade kinds with a minimum record
  (MIN_SCORED managed results, MIN_WIN_RATE wins and a positive profit per
  trade). Closing an open trade is always allowed while it is on.

Every order is checked against the owner's rules before any button is pressed:
the suggestion is in the journal; SPY/QQQ/TSLA; within 14 days; max loss
$100 ($40 debit spreads and lottos); one trade at a time; the $60 daily loss
limit; at most MAX_ENTRIES_PER_DAY entries; no new trades after 3:30pm. Then
the order form and the review screen are read back: contracts, limit, the
strikes, the max loss from collateral and credit, and whether Robinhood shows
the legs as opening (an entry) or closing (an exit). Anything off: nothing is
pressed and the owner is told.

The Dots' own browser tools still never press order buttons (order_guard.py);
only this module does, from the autopilot process (options_watch.py).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path

import options_guide as og

HOME = Path(os.environ.get('OPENDOTS_AUTOPILOT_DIR', r'C:\ProgramData\OpenDots\autopilot'))
MIN_SCORED = 20
MIN_WIN_RATE = 0.80
MAX_ENTRIES_PER_DAY = 3
LAST_ENTRY = 15 * 60 + 30  # No new trades after 3:30pm New York.
MODES = ('dry_run', 'live')
MAX_WRONG = 5        # Wrong PINs before a lock...
LOCKOUT_S = 3600     # ...of an hour.
SUBMIT = re.compile(r'^\s*(submit|place|confirm|send)\b.*|swipe up', re.I)


# PIN, key and signed state --------------------------------------------------
def _read(name: str) -> dict | None:
    try:
        return json.loads((HOME / name).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _write(name: str, value: dict | bytes) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    path = HOME / name
    temp = path.with_suffix('.tmp')
    if isinstance(value, bytes):
        temp.write_bytes(value)
    else:
        temp.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temp, path)


def _hash(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac('sha256', pin.encode(), bytes.fromhex(salt), 200_000).hex()


def pin_set() -> bool:
    return _read('pin.json') is not None


def verify_pin(pin: str) -> bool:
    saved = _read('pin.json')
    return bool(saved and pin and hmac.compare_digest(_hash(str(pin), saved['salt']), saved['hash']))


def set_pin(pin: str, old: str = '') -> None:
    if pin_set() and not verify_pin(old):
        raise PermissionError('The current PIN is wrong.')
    if not re.fullmatch(r'\d{6,12}', str(pin)):
        raise ValueError('The PIN is 6 to 12 digits.')
    salt = secrets.token_hex(16)
    _write('pin.json', {'salt': salt, 'hash': _hash(str(pin), salt)})
    if not (HOME / 'key').exists():
        _write('key', secrets.token_bytes(32))


def _sign(state: dict) -> str:
    key = (HOME / 'key').read_bytes()
    body = json.dumps({k: state[k] for k in ('mode', 'until', 'at')}, sort_keys=True)
    return hmac.new(key, body.encode(), hashlib.sha256).hexdigest()


def state(now: float | None = None) -> dict:
    """The verified state: {'mode': 'off' | 'dry_run' | 'live', 'until', 'note'}."""
    saved = _read('state.json')
    if not saved or saved.get('mode') not in MODES:
        return {'mode': 'off'}
    try:
        good = hmac.compare_digest(_sign(saved), saved.get('sig', ''))
    except (OSError, KeyError):
        good = False
    if not good:
        return {'mode': 'off', 'note': 'The saved state is not signed by the owner: treated as off.'}
    if (now or time.time()) >= saved['until']:
        return {'mode': 'off', 'note': 'It turned itself off at the close.'}
    return {'mode': saved['mode'], 'until': saved['until'], 'since': saved['at']}


def close_today(now: float | None = None) -> float:
    """Today's 4pm New York as a timestamp."""
    now = now or time.time()
    et = og.eastern(datetime.fromtimestamp(now, timezone.utc))
    return now + ((16 * 60) - (et.hour * 60 + et.minute)) * 60 - et.second


def turn_on(pin: str, mode: str, journal: og.Journal | None = None, now: float | None = None) -> dict:
    if not pin_set():
        raise PermissionError('No PIN yet. Set one from a terminal: python localtools/autopilot.py set-pin')
    tries = _read('tries.json') or {'wrong': 0, 'at': 0}
    if tries['wrong'] >= MAX_WRONG and time.time() - tries['at'] < LOCKOUT_S:
        raise PermissionError(f'Too many wrong PINs: locked until {MAX_WRONG} tries cool down '
                              f'({int((LOCKOUT_S - (time.time() - tries["at"])) // 60) + 1} minutes).')
    if not verify_pin(pin):
        wrong = (tries['wrong'] if time.time() - tries['at'] < LOCKOUT_S else 0) + 1
        _write('tries.json', {'wrong': wrong, 'at': time.time()})
        raise PermissionError(f'Wrong PIN ({wrong} of {MAX_WRONG} before a one-hour lock).')
    _write('tries.json', {'wrong': 0, 'at': 0})
    if mode not in MODES:
        raise ValueError('mode is dry_run or live.')
    now = now or time.time()
    until = close_today(now)
    if until <= now:
        raise ValueError('The market has closed for today; turn it on tomorrow morning.')
    if mode == 'live' and not qualified(journal or og.Journal()):
        raise PermissionError(f'No trade kind has the minimum record yet ({MIN_SCORED} scored, '
                              f'{MIN_WIN_RATE:.0%} wins, profit per trade above $0). Use dry run meanwhile.')
    saved = {'mode': mode, 'until': until, 'at': now}
    saved['sig'] = _sign(saved)
    _write('state.json', saved)
    return state(now)


def turn_off() -> dict:
    try:
        (HOME / 'state.json').unlink()
    except FileNotFoundError:
        pass
    return {'mode': 'off'}


# The minimum record ---------------------------------------------------------
def record(journal: og.Journal) -> dict:
    """Per trade kind: the managed record and whether live autopilot may trade it."""
    out = {}
    for kind, k in journal.summary().items():
        scored = k.get('scored', 0)
        ok = scored >= MIN_SCORED and k.get('win_rate', 0) >= MIN_WIN_RATE and k.get('profit_per_trade', 0) > 0
        out[kind] = {'scored': scored, 'win_rate': k.get('win_rate'), 'profit_per_trade': k.get('profit_per_trade'),
                     'qualified': ok}
    return out


def qualified(journal: og.Journal) -> list[str]:
    return [kind for kind, r in record(journal).items() if r['qualified']]


# The order log --------------------------------------------------------------
class Orders:
    def __init__(self, path=og.DB):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS autopilot_orders(ts REAL, day TEXT, trade TEXT, side TEXT, '
                       'mode TEXT, result TEXT, detail TEXT)')

    def add(self, trade: str, side: str, mode: str, result: str, detail: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO autopilot_orders VALUES(?,?,?,?,?,?,?)',
                       (time.time(), og.now_eastern().date().isoformat(), trade, side, mode, result, json.dumps(detail)))

    def entries_today(self, day: date) -> int:
        with closing(sqlite3.connect(self.path)) as db:
            # Dry runs count too, so a dry-run day looks like the live day it stands in for.
            return db.execute("SELECT COUNT(*) FROM autopilot_orders WHERE day=? AND side='entry' AND result IN ('submitted', 'dry_run')",
                              (day.isoformat(),)).fetchone()[0]

    def recent(self, limit: int = 20) -> list[dict]:
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute('SELECT * FROM autopilot_orders ORDER BY ts DESC LIMIT ?', (limit,))]


# The order checks -----------------------------------------------------------
def max_loss_allowed(kind: str) -> float:
    return og.MAX_LOSS if kind in og.CREDIT_KINDS else og.MAX_DEBIT


def check_entry(journal: og.Journal, orders: Orders, suggestion: dict, mode: str, et: datetime) -> list[str]:
    """Reasons a new trade may not be placed (empty: it may)."""
    problems = []
    kind = suggestion['kind']
    if mode == 'live' and kind not in qualified(journal):
        problems.append(f'"{kind}" has not got the minimum record yet.')
    if not journal._rows('id=?', (suggestion.get('id', ''),)):
        problems.append('The suggestion is not in the journal.')
    if suggestion['ticker'] not in og.TICKERS:
        problems.append(f'{suggestion["ticker"]} is not one of {", ".join(og.TICKERS)}.')
    days = (date.fromisoformat(suggestion['expiry']) - et.date()).days
    if not 0 <= days <= og.MAX_DAYS:
        problems.append(f'Expiry {suggestion["expiry"]} is outside 0-{og.MAX_DAYS} days.')
    if suggestion['max_loss'] > max_loss_allowed(kind) + 0.5:
        problems.append(f'Max loss ${suggestion["max_loss"]:.0f} is over ${max_loss_allowed(kind):.0f}.')
    if journal.open_trades():
        problems.append('A trade is already open (one at a time).')
    if journal.loss_today(et) >= og.DAILY_LOSS_LIMIT:
        problems.append('The daily loss limit is reached.')
    if orders.entries_today(et.date()) >= MAX_ENTRIES_PER_DAY:
        problems.append(f'Already {MAX_ENTRIES_PER_DAY} autopilot trades today.')
    if not og.market_open(et) or et.hour * 60 + et.minute >= LAST_ENTRY:
        problems.append('Outside 9:30am-3:30pm New York.')
    return problems


def check_exit(journal: og.Journal, trade: str, legs: list, qty: int) -> list[str]:
    rows = [r for r in journal.open_trades() if r['id'] == trade]
    if not rows:
        return ['That trade is not open in the journal.']
    data = json.loads(rows[0]['data'])
    flip = {'buy': 'sell', 'sell': 'buy'}
    want = sorted((flip[l['action']], l['type'], float(l['strike'])) for l in data['legs'])
    got = sorted((l['action'], l['type'], float(l['strike'])) for l in legs)
    problems = []
    if want != got:
        problems.append('The closing legs do not reverse the open trade.')
    if int(qty) != int(data['qty']):
        problems.append('The closing quantity does not match the open trade.')
    return problems


def money(text: str, label: str) -> float | None:
    found = re.search(label + r'\s*\$?([\d,]+\.?\d*)', text)
    return float(found[1].replace(',', '')) if found else None


def title_for(legs: list, credit: bool) -> str | None:
    """The strategy name Robinhood shows for an opening order, e.g. "Put Credit Spread"."""
    if len(legs) == 2 and legs[0]['type'] == legs[1]['type']:
        return f'{legs[0]["type"].title()} {"Credit" if credit else "Debit"} Spread'
    return None


def check_form(text: str, qty: int, limit: float | None, max_loss: float | None, title: str | None = None) -> list[str]:
    """The filled order form or review screen, read back before a button is pressed.
    Robinhood shows the typed values only in a line like "$0.71 x 100 multiplier x 1 contract"."""
    problems = []
    line = re.search(r'\$([\d.]+)\s*\S\s*100 multiplier\s*\S\s*(\d+) contract', text)
    if not line:
        return ['Could not read the price and contracts from the form.']
    if int(line[2]) != int(qty):
        problems.append(f'The form shows {line[2]} contracts, not {qty}.')
    if limit is not None and abs(float(line[1]) - limit) > 0.011:
        problems.append(f'The form shows a limit of ${float(line[1]):.2f}, not ${limit:.2f}.')
    if title and title.lower() not in text.lower():
        problems.append(f'The form is not a {title}.')
    if max_loss is not None:
        credit, debit, collateral = money(text, 'Estimated credit'), money(text, 'Estimated debit'), money(text, 'Collateral')
        risk = (collateral - credit) if collateral is not None and credit is not None else debit
        if risk is not None and risk > max_loss + 0.5:
            problems.append(f'Robinhood shows ${risk:.2f} at risk, over ${max_loss:.0f}.')
    if re.search(r'Not Enough Buying Power', text, re.I):
        problems.append('Robinhood says there is not enough buying power.')
    return problems


# Pressing the buttons -------------------------------------------------------
SCREEN = r"""() => { const b = [...document.querySelectorAll('button')].find(b => /^(Continue|Review order|Go to Edit|Deposit Funds)$/.test(b.innerText.trim()) || /^(submit|place|confirm|send)\b|swipe up/i.test(b.innerText.trim()));
  let box = b; for (let i = 0; box && i < 12 && !/Limit Price|multiplier/.test(box.innerText); i++) box = box.parentElement;
  return box ? box.innerText : document.body.innerText.slice(0, 3000); }"""


async def place(page, side: str, trade: str, legs: list, qty: int, limit: float | None, max_loss: float | None,
                orders: Orders, problems: list[str], title: str | None = None, pause=asyncio.sleep) -> dict:
    """With the order set up on the page (robinhood_ticket.set_up, which checks
    the legs are on the ticket), check it, press Review order, check the review,
    and in live mode press submit. side: 'entry' or 'exit'. problems: what
    check_entry/check_exit found. title: the strategy name an entry must show."""
    mode = state()['mode']
    detail = {'legs': legs, 'qty': qty, 'limit': limit}

    def stop(result: str, why: list[str]) -> dict:
        orders.add(trade, side, mode, result, {**detail, 'why': why})
        return {'result': result, 'why': why, 'mode': mode}

    if mode == 'off':
        return stop('refused', ['Autopilot is off.'])
    if problems:
        return stop('refused', problems)
    form = await page.evaluate(SCREEN)
    found = check_form(form, qty, limit, max_loss, title)
    if found:
        return stop('refused', found)
    review = page.get_by_role('button', name='Review order')
    if not await review.count():
        return stop('refused', ['No Review order button.'])
    await review.first.click(timeout=5000)
    await pause(2.5)
    text = await page.evaluate(SCREEN)
    found = check_form(text, qty, limit, max_loss, title)
    closing_words = re.search(r'to close', text, re.I)
    if side == 'exit' and not closing_words:
        found.append('Robinhood does not show these legs as closing a position (no open position?).')
    if side == 'entry' and closing_words:
        found.append('Robinhood shows these legs as closing a position, not opening one.')
    if found:
        return stop('refused', found)
    buttons = [b for b in await page.query_selector_all('button') if SUBMIT.search((await b.inner_text()).strip())]
    if mode == 'dry_run':
        return stop('dry_run', [f'Would press "{(await buttons[0].inner_text()).strip()}".' if buttons
                                else 'No submit button was found on the review screen.'])
    if len(buttons) != 1:
        return stop('refused', [f'Expected one submit button on the review screen, found {len(buttons)}.'])
    if mode != state()['mode']:  # Turned off while checking.
        return stop('refused', ['Autopilot was turned off.'])
    label = (await buttons[0].inner_text()).strip()
    await buttons[0].click(timeout=5000)
    await pause(3)
    after = await page.evaluate('() => document.body.innerText.slice(0, 1500)')
    orders.add(trade, side, mode, 'submitted', {**detail, 'pressed': label, 'after': after[:500]})
    return {'result': 'submitted', 'pressed': label, 'mode': mode, 'after': after[:500]}


# The app's Autopilot button calls this (JSON on stdin) -----------------------
def command(request: dict) -> dict:
    journal = og.Journal()
    if request.get('cmd') == 'on':
        turn_on(str(request.get('pin', '')), str(request.get('mode', 'dry_run')), journal)
    elif request.get('cmd') == 'off':
        turn_off()
    return {'state': state(), 'pin_set': pin_set(), 'record': record(journal),
            'minimum': {'scored': MIN_SCORED, 'win_rate': MIN_WIN_RATE},
            'open': [{'id': r['id'], 'kind': r['kind'], 'ticker': r['ticker'], 'entry': r['entry']} for r in journal.open_trades()],
            'orders': Orders().recent(10)}


def main() -> None:
    if sys.argv[1:] == ['set-pin']:
        import getpass
        old = getpass.getpass('Current PIN: ') if pin_set() else ''
        pin = getpass.getpass('New PIN (6-12 digits): ')
        if getpass.getpass('Again: ') != pin:
            sys.exit('The PINs differ; nothing changed.')
        set_pin(pin, old)
        print(f'PIN saved in {HOME}.')
        return
    try:
        print(json.dumps(command(json.loads(sys.stdin.read() or '{}'))))
    except (PermissionError, ValueError) as error:
        print(json.dumps({'error': str(error)}))


if __name__ == '__main__':
    main()
