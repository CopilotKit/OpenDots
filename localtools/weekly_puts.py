"""Weekly uptrend put spreads: a paper record of the spread hold lab's best rule
(2026-10-23, Site Maps/Robinhood/Spread Hold Lab.md), traded exactly as tested:

- at the close, only while SPY closes above its 200-day average;
- sell the SPY put spread expiring 7 days out (the last expiry on or before),
  short leg nearest 30 delta, $5 wide;
- buy it back at a close where it is worth half the credit or less, otherwise
  hold it to expiry (settled at its value at the expiry-day close); no stop;
- one at a time; after one closes, the next may start the following day.

Paper only: nothing is placed. It is $5 wide (about $400 at risk), over the
options guide's $100-a-trade cap, so it is kept apart from the autopilot and its
shadow record. Unlike the lab, it is priced from the real Cboe chain each evening
(mids, $0.02 a side off the mid, $0.03 a contract a side).

Run by options_eod after 4pm New York; python weekly_puts.py shows the record.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import date, timedelta

import numpy as np

import options_guide as og

DTE = 7
DELTA = 0.30
WIDTH = 5.0
TARGET = 0.5
SLIP = 0.02
FEE = 0.03
TREND_DAYS = 200
LAB = 'unseen 2010-2026: 87% wins, +3.6% of the risk a trade, about $820 a year one at a time; losing years 2011, 2018, 2022'


class Record:
    def __init__(self, path=None):
        self.path = str(path or og.Journal().path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS weekly_puts(id TEXT PRIMARY KEY, ts REAL, day TEXT, expiry TEXT, '
                       'short REAL, long REAL, credit REAL, spot REAL, sma200 REAL, result TEXT, closed_day TEXT, '
                       'cost REAL, pnl REAL)')

    def rows(self, where='1=1', args=()) -> list[dict]:
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(f'SELECT * FROM weekly_puts WHERE {where} ORDER BY day', args)]

    def open(self) -> dict | None:
        rows = self.rows("result='open'")
        return rows[-1] if rows else None

    def add(self, pick: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO weekly_puts(id, ts, day, expiry, short, long, credit, spot, sma200, result) '
                       "VALUES(?,?,?,?,?,?,?,?,?,'open')",
                       (uuid.uuid4().hex[:8], time.time(), pick['day'], pick['expiry'], pick['short'], pick['long'],
                        pick['credit'], pick['spot'], pick['sma200']))

    def close(self, id_: str, result: str, day: str, cost: float, pnl: float) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE weekly_puts SET result=?, closed_day=?, cost=?, pnl=? WHERE id=?',
                       (result, day, round(cost, 2), round(pnl, 2), id_))

    def summary(self) -> dict:
        done = self.rows("result!='open'")
        wins = [r for r in done if r['pnl'] > 0]
        return {'trades': len(done), 'wins': len(wins), 'win_rate': round(len(wins) / len(done), 3) if done else None,
                'profit': round(sum(r['pnl'] for r in done), 2), 'open': self.open(), 'recent': done[-6:][::-1],
                'rule': f'SPY above its {TREND_DAYS}-day average: sell the {DTE}-day {int(DELTA * 100)}-delta put spread, '
                        f'${WIDTH:g} wide; take {int(TARGET * 100)}%, else hold to expiry', 'lab': LAB}


def puts(chain: dict) -> dict:
    """{expiry: {strike: option}} for puts with a two-sided quote."""
    out: dict = {}
    for o in chain['options']:
        if not o['call'] and o['ask'] > 0:
            out.setdefault(o['expiry'], {})[o['strike']] = o
    return out


def mid(o: dict) -> float:
    return (o['bid'] + o['ask']) / 2


def choose(chain: dict, today: date) -> dict | None:
    """The tested spread: the last expiry on or before 7 days out, short put nearest 30 delta, $5 wide."""
    book = puts(chain)
    expiries = [e for e in book if today < e <= today + timedelta(days=DTE)]
    if not expiries:
        return None
    expiry = max(expiries)
    legs = book[expiry]
    shorts = sorted((o for o in legs.values() if o['strike'] < chain['price'] and o['bid'] > 0 and o['delta']),
                    key=lambda o: abs(abs(o['delta']) - DELTA))
    for short in shorts[:3]:
        long = legs.get(short['strike'] - WIDTH)
        if long:
            return {'expiry': expiry.isoformat(), 'short': short['strike'], 'long': long['strike'],
                    'mid': round(mid(short) - mid(long), 2), 'delta': short['delta']}
    return None


def evening(chain: dict, closes: dict, record: Record | None = None, today: date | None = None) -> dict:
    """Tonight's step: settle or score the open pick, then open a new one if the rule says so.
    closes: {'YYYY-MM-DD': SPY close}, through today."""
    record = record or Record()
    today = today or chain['asof'].date()
    key = today.isoformat()
    did = {}
    pick = record.open()
    if pick:
        expiry = date.fromisoformat(pick['expiry'])
        if today >= expiry:
            close = closes.get(pick['expiry']) or closes[max(d for d in closes if d <= pick['expiry'])]
            cost = min(max(pick['short'] - close, 0) - max(pick['long'] - close, 0), WIDTH)
            pnl = (pick['credit'] - cost) * 100 - 2 * FEE
            record.close(pick['id'], 'held to expiry', pick['expiry'], cost, pnl)
            did['closed'] = {'how': 'held to expiry', 'pnl': round(pnl, 2)}
        else:
            legs = puts(chain).get(expiry, {})
            short, long = legs.get(pick['short']), legs.get(pick['long'])
            if short and long:
                now = mid(short) - mid(long)
                did['marked'] = round(now, 2)
                if now <= (1 - TARGET) * (pick['credit'] + SLIP):  # Half the entry mid.
                    cost = now + SLIP
                    pnl = (pick['credit'] - cost) * 100 - 4 * FEE
                    record.close(pick['id'], f'took {int(TARGET * 100)}%', key, cost, pnl)
                    did['closed'] = {'how': f'took {int(TARGET * 100)}%', 'pnl': round(pnl, 2)}
        if 'closed' not in did:
            return did
    if any(r['closed_day'] == key for r in record.rows("result!='open'")):
        return {**did, 'entry': 'waits a day after a close, as tested'}
    days = sorted(d for d in closes if d <= key)[-TREND_DAYS:]
    if len(days) < TREND_DAYS:
        return {**did, 'entry': f'only {len(days)} daily closes'}
    sma = float(np.mean([closes[d] for d in days]))
    spot = closes.get(key, chain['price'])
    if spot <= sma:
        return {**did, 'entry': f'SPY {spot:.2f} is not above its 200-day average {sma:.2f}'}
    spread = choose(chain, today)
    if not spread or spread['mid'] - SLIP < 0.05:
        return {**did, 'entry': 'no spread in the chain'}
    record.add({'day': key, 'expiry': spread['expiry'], 'short': spread['short'], 'long': spread['long'],
                'credit': round(spread['mid'] - SLIP, 2), 'spot': round(spot, 2), 'sma200': round(sma, 2)})
    return {**did, 'entry': spread}


if __name__ == '__main__':
    print(json.dumps(Record().summary(), indent=1, default=str))
