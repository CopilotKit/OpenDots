"""Real option history for the strategy lab: end-of-day chains, kept on disk.

Two sources:
- Alpha Vantage HISTORICAL_OPTIONS: the full chain of a symbol on a past date
  (bid, ask, implied volatility, greeks). The free key allows about 25 requests a
  day, one request being one day of one symbol, so the download runs a little
  every day (the 4:15pm task) and starts with the stretches that matter most:
  the bad weeks, where credit spreads lose.
- The Cboe chain OpenDots already reads: saved every evening from now on.

The key is read from ALPHAVANTAGE_API_KEY (environment or OpenDots' .env).

Run: python option_history.py test     one request, to check the key
     python option_history.py fetch    the next days in the plan, within today's budget
     python option_history.py status   what is saved
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / 'data' / 'option-history'
DAILY_BUDGET = 24  # The free key's 25 a day, less one to spare.
SYMBOLS = ('SPY', 'QQQ')
URL = 'https://www.alphavantage.co/query'

# The bad stretches first (where selling premium is tested), then calm ones to compare.
STRETCHES = (
    ('August 2024 volatility spike', '2024-07-24', '2024-08-16'),
    ('April 2025 tariff selloff', '2025-03-26', '2025-04-17'),
    ('September 2022 bear market', '2022-09-07', '2022-09-30'),
    ('March 2020 crash', '2020-02-21', '2020-03-20'),
    ('December 2024 Fed day drop', '2024-12-12', '2024-12-27'),
    ('Calm: May 2024', '2024-05-01', '2024-05-24'),
    ('Calm: November 2023', '2023-11-01', '2023-11-22'),
    ('Calm: July 2025', '2025-07-01', '2025-07-25'),
)


def api_key() -> str:
    key = os.environ.get('ALPHAVANTAGE_API_KEY', '').strip()
    if not key and (ROOT / '.env').exists():
        for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
            if line.strip().startswith('ALPHAVANTAGE_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"\'')
    if not key:
        raise LookupError('No Alpha Vantage key: add ALPHAVANTAGE_API_KEY=... to OpenDots\' .env file.')
    return key


def weekdays(start: str, end: str) -> list[str]:
    day, last, out = date.fromisoformat(start), date.fromisoformat(end), []
    while day <= last:
        if day.weekday() < 5:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def path(symbol: str, day: str) -> Path:
    return STORE / 'alphavantage' / symbol / f'{day}.json.gz'


def saved(symbol: str, day: str) -> list[dict] | None:
    p = path(symbol, day)
    if not p.exists():
        return None
    return json.loads(gzip.decompress(p.read_bytes()))


class Budget:
    """Requests made today, so the free key's daily limit is never hit."""

    def __init__(self, limit: int = DAILY_BUDGET):
        self.file = STORE / 'usage.json'
        self.limit = limit

    def used(self) -> int:
        try:
            data = json.loads(self.file.read_text())
        except (OSError, ValueError):
            return 0
        return data['count'] if data.get('day') == date.today().isoformat() else 0

    def spend(self) -> None:
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps({'day': date.today().isoformat(), 'count': self.used() + 1}))

    def left(self) -> int:
        return max(self.limit - self.used(), 0)


def fetch(symbol: str, day: str, budget: Budget | None = None, get=None) -> list[dict]:
    """One day's chain (cached). Raises on a refusal (no access, limit reached)."""
    hit = saved(symbol, day)
    if hit is not None:
        return hit
    budget = budget or Budget()
    if not budget.left():
        raise RuntimeError('Today\'s Alpha Vantage budget is used up; the rest comes tomorrow.')
    if get is None:
        import requests
        get = lambda params: requests.get(URL, params=params, timeout=60).json()
    budget.spend()
    body = get({'function': 'HISTORICAL_OPTIONS', 'symbol': symbol, 'date': day, 'apikey': api_key()})
    rows = body.get('data')
    if not isinstance(rows, list):
        message = body.get('Information') or body.get('Note') or body.get('Error Message') or str(body)[:300]
        raise RuntimeError(f'Alpha Vantage refused {symbol} {day}: {message}')
    rows = [parse(r) for r in rows]
    rows = [r for r in rows if r]
    p = path(symbol, day)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(gzip.compress(json.dumps(rows).encode()))  # An empty list marks a market holiday.
    return rows


def parse(row: dict) -> dict | None:
    """Alpha Vantage's strings to numbers: the fields the lab needs."""
    try:
        return {'expiry': row['expiration'], 'strike': float(row['strike']), 'call': row['type'].lower() == 'call',
                'bid': float(row.get('bid') or 0), 'ask': float(row.get('ask') or 0),
                'iv': float(row.get('implied_volatility') or 0), 'delta': float(row.get('delta') or 0),
                'volume': float(row.get('volume') or 0), 'oi': float(row.get('open_interest') or 0)}
    except (KeyError, ValueError, AttributeError):
        return None


def plan() -> list[tuple[str, str, str]]:
    """(stretch, symbol, day) in download order: each stretch whole, SPY and QQQ together."""
    return [(name, symbol, day) for name, start, end in STRETCHES for day in weekdays(start, end) for symbol in SYMBOLS]


def fetch_next(budget: Budget | None = None, get=None, log=print) -> dict:
    budget = budget or Budget()
    done, failed = 0, None
    for name, symbol, day in plan():
        if path(symbol, day).exists():
            continue
        if not budget.left():
            break
        try:
            rows = fetch(symbol, day, budget, get)
            done += 1
            log(f'{name}: {symbol} {day}: {len(rows)} contracts')
        except RuntimeError as error:
            failed = str(error)
            break
        time.sleep(13 if get is None else 0)  # Also under the free key's 5 a minute.
    return {'downloaded': done, 'stopped_on': failed, **status()}


def status() -> dict:
    out = {}
    for name, start, end in STRETCHES:
        days = weekdays(start, end)
        out[name] = f'{sum(path(s, d).exists() for s in SYMBOLS for d in days)} of {len(days) * len(SYMBOLS)} days'
    return {'stretches': out, 'left_today': Budget().left()}


def save_cboe(ticker: str, document: dict, day: str) -> Path:
    """The evening's Cboe chain, as-is, for the lab's own real history from now on."""
    p = STORE / 'cboe' / ticker / f'{day}.json.gz'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(gzip.compress(json.dumps(document).encode()))
    return p


if __name__ == '__main__':
    command = (sys.argv[1:] or ['status'])[0]
    if command == 'test':
        rows = fetch('SPY', '2024-08-05')
        print(json.dumps({'contracts': len(rows), 'sample': rows[:2]}, indent=1))
    elif command == 'fetch':
        print(json.dumps(fetch_next(), indent=1))
    else:
        print(json.dumps(status(), indent=1))
