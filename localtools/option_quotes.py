"""Option quote recorder: real bid/ask history for the scalp simulator.

Every 20 seconds during the session it reads the Cboe chains OpenDots already uses
(SPY, QQQ, TSLA) and saves the near-the-money contracts of the nearest expiries:
bid, ask, implied volatility, delta, volume, open interest, and the stock price
from the same snapshot. Cboe publishes a new snapshot about once a minute, so a
day is roughly 400 snapshots per ticker; an unchanged snapshot is not saved twice.

Cboe's quotes run about 15 minutes behind its publish time (QUOTE_DELAY), and the
stock price in the snapshot runs behind with them, so each snapshot is consistent
in itself. `asof` is the publish time; `session_time()` gives the market time.

For the owner's own testing: Cboe's delayed quotes are for personal use, not
for redistribution.

Run: python option_quotes.py           record until 4:20pm (the scheduled task)
     python option_quotes.py once      one pass, to check it works
     python option_quotes.py status    what is saved
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path

import options_guide as og

TICKERS = ('SPY', 'QQQ', 'TSLA')
EXPIRIES = 2  # Nearest expiries kept: today's and the next for SPY/QQQ, the next two Fridays-ish for TSLA.
BAND = 0.02  # Strikes within 2% of the price: where quick flips happen.
EVERY_S = 20  # Cboe publishes about once a minute; faster only re-reads the same snapshot.
QUOTE_DELAY = timedelta(minutes=15)
START, STOP = (9, 30), (16, 20)  # Publish times: the delayed quotes cover 9:15am-4:05pm.
DB = Path(__file__).parent.parent / 'data' / 'option-quotes.sqlite'


def session_time(asof: datetime) -> datetime:
    """The market time a snapshot's quotes are from."""
    return asof - QUOTE_DELAY


def near(chain: dict, expiries: int = EXPIRIES, band: float = BAND) -> list[dict]:
    """The contracts worth keeping: nearest expiries, strikes within the band, a real quote."""
    today = chain['asof'].date()
    kept = sorted({o['expiry'] for o in chain['options'] if o['expiry'] >= today})[:expiries]
    low, high = chain['price'] * (1 - band), chain['price'] * (1 + band)
    return [o for o in chain['options']
            if o['expiry'] in kept and low <= o['strike'] <= high and o['ask'] > 0 and o['ask'] >= o['bid']]


class Store:
    """data/option-quotes.sqlite: one row per snapshot, one per contract per snapshot."""

    def __init__(self, path: Path = DB):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS snapshots(ticker TEXT, asof TEXT, spot REAL, fetched REAL, '
                       'PRIMARY KEY(ticker, asof))')
            db.execute('CREATE TABLE IF NOT EXISTS quotes(ticker TEXT, asof TEXT, symbol TEXT, expiry TEXT, strike REAL, '
                       'call INTEGER, bid REAL, ask REAL, iv REAL, delta REAL, volume REAL, oi REAL, '
                       'PRIMARY KEY(symbol, asof))')
            db.execute('CREATE INDEX IF NOT EXISTS quotes_by_day ON quotes(ticker, asof)')

    def save(self, ticker: str, chain: dict, fetched: float | None = None) -> int:
        """Saves a snapshot; returns the contracts saved (0 when this snapshot is already in)."""
        asof = chain['asof'].strftime('%Y-%m-%d %H:%M:%S')
        rows = [(ticker, asof, o['symbol'], o['expiry'].isoformat(), o['strike'], int(o['call']), o['bid'], o['ask'],
                 o['iv'], o['delta'], o['volume'], o['oi']) for o in near(chain)]
        with closing(sqlite3.connect(self.path)) as db, db:
            new = db.execute('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?)',
                             (ticker, asof, chain['price'], fetched or time.time())).rowcount
            if not new:
                return 0
            db.executemany('INSERT OR IGNORE INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        return len(rows)

    def days(self, ticker: str | None = None) -> list[str]:
        with closing(sqlite3.connect(self.path)) as db:
            sql, args = 'SELECT DISTINCT substr(asof, 1, 10) FROM snapshots', ()
            if ticker:
                sql, args = sql + ' WHERE ticker=?', (ticker,)
            return sorted(r[0] for r in db.execute(sql, args))

    def day(self, ticker: str, day: str) -> list[dict]:
        """One day's snapshots in order: [{asof, spot, quotes: {symbol: {...}}}]."""
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            snaps = {r['asof']: {'asof': datetime.strptime(r['asof'], '%Y-%m-%d %H:%M:%S'), 'spot': r['spot'], 'quotes': {}}
                     for r in db.execute('SELECT * FROM snapshots WHERE ticker=? AND substr(asof,1,10)=? ORDER BY asof',
                                         (ticker, day))}
            for r in db.execute('SELECT * FROM quotes WHERE ticker=? AND substr(asof,1,10)=?', (ticker, day)):
                if r['asof'] in snaps:
                    snaps[r['asof']]['quotes'][r['symbol']] = {
                        'expiry': date.fromisoformat(r['expiry']), 'strike': r['strike'], 'call': bool(r['call']),
                        'bid': r['bid'], 'ask': r['ask'], 'iv': r['iv'], 'delta': r['delta']}
        return list(snaps.values())

    def status(self) -> dict:
        with closing(sqlite3.connect(self.path)) as db:
            per = {t: {'days': n, 'snapshots': s} for t, n, s in db.execute(
                'SELECT ticker, COUNT(DISTINCT substr(asof,1,10)), COUNT(*) FROM snapshots GROUP BY ticker')}
            quotes = db.execute('SELECT COUNT(*) FROM quotes').fetchone()[0]
        return {'tickers': per, 'quotes': quotes, 'size_mb': round(self.path.stat().st_size / 1e6, 1)}


def record_once(store: Store, getter=og.fetch, log=print) -> dict:
    """One pass over the tickers; one ticker's failure does not stop the others."""
    saved = {}
    for ticker in TICKERS:
        try:
            saved[ticker] = store.save(ticker, og.parse_chain(getter(f'options/{ticker}.json', 0)))
        except Exception as error:  # Feed hiccup: try again next pass.
            saved[ticker] = f'failed: {type(error).__name__}: {error}'
            log(f'{ticker}: {saved[ticker]}')
    return saved


def run(store: Store, getter=og.fetch, clock=og.now_eastern, sleep=time.sleep, log=print) -> None:
    """Records from 9:30am until 4:20pm New York time on a weekday."""
    while True:
        now = clock()
        minutes = now.hour * 60 + now.minute
        if now.weekday() >= 5 or minutes >= STOP[0] * 60 + STOP[1]:
            break
        if minutes >= START[0] * 60 + START[1]:
            record_once(store, getter, log)
        sleep(EVERY_S)


if __name__ == '__main__':
    command = (sys.argv[1:] or ['run'])[0]
    store = Store()
    if command == 'once':
        print(json.dumps(record_once(store), indent=1))
    elif command == 'status':
        print(json.dumps(store.status(), indent=1))
    else:
        run(store, log=lambda message: print(message, file=sys.stderr, flush=True))
