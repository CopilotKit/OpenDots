"""Options guide: finds defined-risk trades on SPY, QQQ and TSLA within the
owner's rules, explains them, and keeps a journal so every kind of suggestion
is measured. The Dots never place the order: on Robinhood they set it up and
hover on the button (order_guard.py); the owner presses it.

Rules (MainAINotes/Site Maps/Robinhood/Credit Spread Rules.md, 2026-10-21):
SPY/QQQ/TSLA only; expiry today to 14 days out; credit spreads, debit spreads
and cheap "lotto" options, never a naked short; $200 learning budget: max loss
$100 a trade, $40 for debit spreads and lottos, one trade open at a time, no
new suggestions after a $60 losing day.

The edge for a premium seller is implied volatility (what the option prices
assume) above the volatility that actually happens. Every candidate is valued
twice over the spread of possible prices at expiry: at the market's implied
volatility and at our forecast from recent realized volatility; only those
with a positive expected value at the forecast are suggested. Prices come from
Cboe's free feed, delayed about 15 minutes: check the live price on the
broker before the hand-off.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from trading_feed import ema, macd_histogram, rsi

TICKERS = ('SPY', 'QQQ', 'TSLA')
MAX_DAYS = 14
MAX_LOSS = 100.0  # Dollars, per trade.
MAX_DEBIT = 40.0  # Debit spreads and lottos.
DAILY_LOSS_LIMIT = 60.0
FEE = 0.03  # Estimated regulatory fees per contract per side (Robinhood charges no commission).
LOTTO_ASK = (0.01, 0.02)
LOTTO_QTY = 10
LOTTO_TARGET = 0.05
SHORT_DELTA = (0.10, 0.25)
MIN_POP = 0.80  # Credit spreads: the owner's 80% win-rate target (2026-10-21).
CREDIT_KINDS = ('decay spread', 'day credit spread')
DEBIT_DELTA = (0.30, 0.55)
CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes'
DB = Path(__file__).parent.parent / 'data' / 'options-guide.sqlite'
SYMBOL = re.compile(r'^([A-Z]+)(\d{6})([CP])(\d{8})$')
GRID = np.linspace(-6, 6, 481)  # Standard-normal grid for expected values.
WEIGHTS = np.exp(-GRID ** 2 / 2)
WEIGHTS /= WEIGHTS.sum()


# Time: New York, without tz data (Windows Python has none) ----------------
def eastern(utc: datetime) -> datetime:
    """UTC -> New York local time (US daylight saving rules since 2007)."""
    utc = utc.replace(tzinfo=None)
    year = utc.year
    march = datetime(year, 3, 8) + timedelta(days=(6 - datetime(year, 3, 8).weekday()) % 7)  # 2nd Sunday
    november = datetime(year, 11, 1) + timedelta(days=(6 - datetime(year, 11, 1).weekday()) % 7)  # 1st Sunday
    dst = march + timedelta(hours=7) <= utc < november + timedelta(hours=6)  # 2am local in UTC
    return utc - timedelta(hours=4 if dst else 5)


def now_eastern() -> datetime:
    return eastern(datetime.now(timezone.utc))


def market_open(et: datetime) -> bool:
    minutes = et.hour * 60 + et.minute
    return et.weekday() < 5 and 9 * 60 + 30 <= minutes < 16 * 60


def years_to(expiry: date, et: datetime) -> float:
    """Calendar years from now to 4pm New York on the expiry day (at least a minute)."""
    close = datetime(expiry.year, expiry.month, expiry.day, 16)
    return max((close - et).total_seconds(), 60) / (365 * 24 * 3600)


def years_to_close(et: datetime) -> float:
    close = et.replace(hour=16, minute=0, second=0, microsecond=0)
    return max((close - et).total_seconds(), 0) / (365 * 24 * 3600)


# Pricing ------------------------------------------------------------------
def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(spot, strike, years, vol, call: bool):
    """Black-Scholes value (no rates or dividends: weeks out, they barely matter).
    Works on numpy arrays of spot prices too."""
    spot = np.asarray(spot, dtype=float)
    intrinsic = np.maximum(spot - strike, 0) if call else np.maximum(strike - spot, 0)
    if years <= 0 or vol <= 0:
        return intrinsic
    root = vol * math.sqrt(years)
    d1 = (np.log(spot / strike) + 0.5 * vol * vol * years) / root
    d2 = d1 - root
    n = np.vectorize(ncdf)
    if call:
        return spot * n(d1) - strike * n(d2)
    return strike * n(-d2) - spot * n(-d1)


def terminal(spot: float, vol: float, years: float) -> np.ndarray:
    """Possible prices at a horizon on the standard-normal grid (no drift)."""
    root = vol * math.sqrt(max(years, 0))
    return spot * np.exp(-0.5 * root * root + root * GRID)


def summarize(payoff: np.ndarray) -> dict:
    """Expected value and chance of profit of a payoff over the grid."""
    return {'ev': float((payoff * WEIGHTS).sum()), 'pop': float(WEIGHTS[payoff > 0].sum())}


# Market data ----------------------------------------------------------------
_cache: dict = {}


def fetch(path: str, max_age: float = 60) -> dict:
    """A Cboe delayed-quotes JSON document, cached for a minute."""
    import requests
    hit = _cache.get(path)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    response = requests.get(f'{CBOE}/{path}', timeout=30, headers={'User-Agent': 'Mozilla/5.0'})
    response.raise_for_status()
    data = response.json()
    _cache[path] = (time.time(), data)
    return data


def parse_chain(document: dict) -> dict:
    """The chain as {price, iv30, asof (New York time), options: [...]}."""
    data = document['data']
    options = []
    for row in data.get('options', []):
        match = SYMBOL.match(row.get('option', ''))
        if not match:
            continue
        _, ymd, side, strike = match.groups()
        options.append({
            'symbol': row['option'], 'expiry': date(2000 + int(ymd[:2]), int(ymd[2:4]), int(ymd[4:])),
            'call': side == 'C', 'strike': int(strike) / 1000, 'bid': float(row.get('bid') or 0),
            'ask': float(row.get('ask') or 0), 'iv': float(row.get('iv') or 0), 'delta': float(row.get('delta') or 0),
            'theta': float(row.get('theta') or 0), 'oi': float(row.get('open_interest') or 0),
            'volume': float(row.get('volume') or 0)})
    stamp = datetime.strptime(document['timestamp'], '%Y-%m-%d %H:%M:%S')
    return {'price': float(data['current_price']), 'iv30': float(data.get('iv30') or 0) / 100,
            'asof': eastern(stamp), 'options': options}


def realized_vol(closes: list[float], per_year: float) -> float | None:
    if len(closes) < 10:
        return None
    returns = np.diff(np.log(np.asarray(closes, dtype=float)))
    return float(returns.std(ddof=1) * math.sqrt(per_year))


def forecast_vol(daily: list[float], minutes: list[float]) -> float | None:
    """Expected volatility: the last 20 days' and today's realized volatility, averaged."""
    parts = [v for v in (realized_vol(daily[-21:], 252), realized_vol(minutes, 252 * 390)) if v]
    return sum(parts) / len(parts) if parts else None


def trend(minutes: list[float]) -> dict:
    """Intraday direction: RSI, MACD and EMA agreeing, on 5-minute closes once
    there are 30 of them (about 12pm), on 1-minute closes before that."""
    closes = minutes[4::5] if len(minutes) >= 150 else minutes
    if len(closes) < 35:
        return {'direction': 'unclear', 'why': 'too early in the day for a trend reading (needs ~35 minutes)'}
    value, hist, line = rsi(closes), macd_histogram(closes), ema(closes, 9)
    slope = line[-1] - line[-4]
    up = value is not None and value >= 55 and hist and hist[-1] > 0 and slope > 0
    down = value is not None and value <= 45 and hist and hist[-1] < 0 and slope < 0
    why = f'RSI {value:.0f}, MACD {"above" if hist and hist[-1] > 0 else "below"} signal, EMA9 {"rising" if slope > 0 else "falling"}'
    return {'direction': 'up' if up else 'down' if down else 'unclear', 'why': why}


def market(ticker: str, getter=fetch) -> dict:
    ticker = ticker.upper()
    if ticker not in TICKERS:
        raise ValueError(f'Only {", ".join(TICKERS)} are traded (owner rules).')
    chain = parse_chain(getter(f'options/{ticker}.json'))
    minutes = [b['price']['close'] for b in getter(f'charts/intraday/{ticker}.json').get('data', [])]
    daily = [d['close'] for d in getter(f'charts/historical/{ticker}.json', 3600).get('data', [])[-60:]]
    sigma = forecast_vol(daily, minutes)
    left = years_to_close(chain['asof'])
    return {**chain, 'ticker': ticker, 'minutes': minutes, 'daily': daily, 'forecast_vol': sigma,
            'trend': trend(minutes),
            'expected_move_today': round(chain['price'] * (sigma or chain['iv30']) * math.sqrt(left), 2)}


# Candidate finders ----------------------------------------------------------
def by_strike(options: list[dict]) -> dict:
    return {o['strike']: o for o in options}


def credit_spreads(m: dict, top: int = 3) -> list[dict]:
    """Out-of-the-money put and call credit spreads at 0.10-0.25 delta, the
    narrowest width available, max loss within budget, positive edge only."""
    et, sigma, out = m['asof'], m['forecast_vol'], []
    if not sigma:
        return out
    for expiry in sorted({o['expiry'] for o in m['options']}):
        days = (expiry - et.date()).days
        if days < 0 or days > MAX_DAYS:
            continue
        years = years_to(expiry, et)
        prices = terminal(m['price'], sigma, years)
        for call in (False, True):
            legs = sorted((o for o in m['options'] if o['expiry'] == expiry and o['call'] == call), key=lambda o: o['strike'])
            strikes = by_strike(legs)
            for short in legs:
                if not SHORT_DELTA[0] <= abs(short['delta']) <= SHORT_DELTA[1] or short['bid'] <= 0:
                    continue
                # The protective leg: the next strike further out of the money.
                further = [s for s in strikes if (s > short['strike'] if call else s < short['strike'])]
                if not further:
                    continue
                longk = min(further) if call else max(further)
                long = strikes[longk]
                width = abs(longk - short['strike'])
                credit = round(short['bid'] - long['ask'], 2)  # Natural price: sell at bid, buy at ask.
                max_loss = round((width - credit) * 100 + 4 * FEE, 2)
                if credit < 0.05 or max_loss > MAX_LOSS:
                    continue
                k1, k2 = short['strike'], longk

                def payoff(at, k1=k1, k2=k2, credit=credit, call=call):
                    """Dollars at expiry for prices `at`: the credit, less the short leg, plus the long."""
                    owed = (lambda k: np.maximum(at - k, 0)) if call else (lambda k: np.maximum(k - at, 0))
                    return (credit - owed(k1) + owed(k2)) * 100 - 4 * FEE

                edge = summarize(payoff(prices))
                implied = summarize(payoff(terminal(m['price'], short['iv'] or sigma, years)))
                if edge['ev'] <= 0 or edge['pop'] < MIN_POP:
                    continue
                kind = 'decay spread' if days == 0 else 'day credit spread'
                side = 'call' if call else 'put'
                out.append({
                    'kind': kind, 'ticker': m['ticker'], 'expiry': expiry.isoformat(), 'days': days,
                    'legs': [{'action': 'sell', 'symbol': short['symbol'], 'type': side, 'strike': k1, 'iv': short['iv']},
                             {'action': 'buy', 'symbol': long['symbol'], 'type': side, 'strike': k2, 'iv': long['iv']}],
                    'qty': 1, 'price': credit, 'max_loss': max_loss, 'max_gain': round(credit * 100 - 4 * FEE, 2),
                    'pop': round(edge['pop'], 3), 'ev': round(edge['ev'], 2), 'ev_at_implied': round(implied['ev'], 2),
                    'short_delta': short['delta'], 'short_iv': short['iv'], 'theta_per_day': round((short['theta'] - long['theta']) * -100, 2),
                    'why': (f'{side.title()} credit spread {k1:g}/{k2:g}: collect ${credit:.2f} (${credit * 100:.0f}); '
                            f'{edge["pop"]:.0%} chance of profit at expiry; short strike {abs(short["delta"]):.2f} delta; '
                            f'implied vol {short["iv"]:.0%} vs forecast {sigma:.0%}.'),
                    'manage': ('Close at 40-50% of the credit, or if the spread is worth 2x the credit, or price '
                               'passes the short strike.' if days else 'Same day: close at 30-40% of the credit '
                               'or by 3:45pm; close at once if price reaches the short strike.')})
    out.sort(key=lambda c: c['ev'] / c['max_loss'], reverse=True)
    return out[:top]


def debit_spreads(m: dict, top: int = 2) -> list[dict]:
    """Directional spreads in the intraday trend's direction only, debit within budget."""
    et, sigma, direction, out = m['asof'], m['forecast_vol'], m['trend']['direction'], []
    if not sigma or direction == 'unclear':
        return out
    call = direction == 'up'
    for expiry in sorted({o['expiry'] for o in m['options']}):
        days = (expiry - et.date()).days
        if days < 0 or days > MAX_DAYS:
            continue
        years = years_to(expiry, et)
        prices = terminal(m['price'], sigma, years)
        legs = sorted((o for o in m['options'] if o['expiry'] == expiry and o['call'] == call), key=lambda o: o['strike'])
        strikes = by_strike(legs)
        for long in legs:
            if not DEBIT_DELTA[0] <= abs(long['delta']) <= DEBIT_DELTA[1] or long['ask'] <= 0:
                continue
            further = [s for s in strikes if (s > long['strike'] if call else s < long['strike'])]
            if not further:
                continue
            shortk = min(further) if call else max(further)
            short = strikes[shortk]
            debit = round(long['ask'] - short['bid'], 2)
            cost = round(debit * 100 + 4 * FEE, 2)
            if debit <= 0 or cost > MAX_DEBIT:
                continue
            k1, k2 = long['strike'], shortk
            value = (np.minimum(np.maximum(prices - k1, 0), k2 - k1) if call else np.minimum(np.maximum(k1 - prices, 0), k1 - k2))
            stats = summarize(value * 100 - cost)
            breakeven = k1 + debit if call else k1 - debit
            out.append({
                'kind': 'debit spread', 'ticker': m['ticker'], 'expiry': expiry.isoformat(), 'days': days,
                'legs': [{'action': 'buy', 'symbol': long['symbol'], 'type': 'call' if call else 'put', 'strike': k1, 'iv': long['iv']},
                         {'action': 'sell', 'symbol': short['symbol'], 'type': 'call' if call else 'put', 'strike': k2, 'iv': short['iv']}],
                'qty': 1, 'price': -debit, 'max_loss': cost, 'max_gain': round(abs(k2 - k1) * 100 - cost, 2),
                'pop': round(stats['pop'], 3), 'ev': round(stats['ev'], 2), 'breakeven': round(breakeven, 2),
                'why': (f'{"Call" if call else "Put"} debit spread {k1:g}/{k2:g} for ${debit:.2f} (${cost:.0f}), with '
                        f'the trend ({m["trend"]["why"]}). Pays if price ends past {breakeven:.2f}; '
                        f'{stats["pop"]:.0%} chance at forecast volatility, which assumes no trend: the trend is the bet.'),
                'manage': 'Take profit at +50-100% of the debit; it can expire worthless (the debit is the most it can lose).'})
    out.sort(key=lambda c: c['ev'], reverse=True)
    return out[:top]


def needed_price(option: dict, years_after_close: float, target: float, spot: float) -> float:
    """The underlying price at today's close at which the option is worth `target`."""
    lo, hi = (spot, spot * 1.5) if option['call'] else (spot * 0.5, spot)
    vol = option['iv'] or 0.3
    for _ in range(60):
        mid = (lo + hi) / 2
        worth = float(bs_price(mid, option['strike'], years_after_close, vol, option['call']))
        if (worth < target) == option['call']:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def lottos(m: dict, top: int = 3) -> list[dict]:
    """10 cheap out-of-the-money options ($0.01-$0.02 with a real bid) that
    would be worth about $0.05 at today's close if price moves their way."""
    et, sigma, out = m['asof'], m['forecast_vol'], []
    left = years_to_close(et)
    if not sigma or left <= 0:
        return out
    if left * 365 * 24 < 0.5:
        return out  # Under half an hour left: too late to start a lotto.
    closes = terminal(m['price'], sigma, left)
    for option in m['options']:
        days = (option['expiry'] - et.date()).days
        if not 0 <= days <= 2 or not LOTTO_ASK[0] <= option['ask'] <= LOTTO_ASK[1] or option['bid'] < 0.01:
            continue
        otm = option['strike'] > m['price'] if option['call'] else option['strike'] < m['price']
        if not otm:
            continue
        after = max(years_to(option['expiry'], et) - left, 0)  # Time it still has after today's close.
        target_price = needed_price(option, after, LOTTO_TARGET, m['price'])
        move = target_price / m['price'] - 1
        worth = bs_price(closes, option['strike'], after, option['iv'] or sigma, option['call'])
        cost = option['ask'] * 100 * LOTTO_QTY + LOTTO_QTY * FEE
        payoff = np.minimum(worth, 10) * 100 * LOTTO_QTY - cost - LOTTO_QTY * FEE
        stats = summarize(payoff)
        reach = float(WEIGHTS[(closes >= target_price) if option['call'] else (closes <= target_price)].sum())
        if cost > MAX_DEBIT or reach < 0.02:
            continue
        side = 'call' if option['call'] else 'put'
        out.append({
            'kind': 'lotto', 'ticker': m['ticker'], 'expiry': option['expiry'].isoformat(), 'days': days,
            'legs': [{'action': 'buy', 'symbol': option['symbol'], 'type': side, 'strike': option['strike'], 'iv': option['iv']}],
            'qty': LOTTO_QTY, 'price': -option['ask'], 'max_loss': round(cost, 2), 'max_gain': None,
            'pop': round(stats['pop'], 3), 'ev': round(stats['ev'], 2), 'reach_target': round(reach, 3),
            'touch_target': round(min(1.0, 2 * reach), 3), 'target_underlying': round(target_price, 2),
            'why': (f'{LOTTO_QTY} x {m["ticker"]} {option["strike"]:g} {side} at ${option["ask"]:.2f} '
                    f'(${cost:.0f} total, bid ${option["bid"]:.2f}). Worth ~${LOTTO_TARGET:.2f} if {m["ticker"]} is at '
                    f'{target_price:.2f} by the close ({move:+.2%} from {m["price"]:.2f}): {reach:.0%} chance at the close, '
                    f'about {min(1.0, 2 * reach):.0%} of touching it during the day.'),
            'manage': f'Sell at ~${LOTTO_TARGET:.2f} if touched; otherwise let it go - most expire worthless.',
            **({'warning': 'Negative expected value: a lottery ticket. Take it only for a reason the odds do not '
                           'show (news, a strong trend into the close), and only with the lotto slice of the budget.'}
               if stats['ev'] < 0 else {})})
    out.sort(key=lambda c: c['ev'], reverse=True)
    return out[:top]


# Journal --------------------------------------------------------------------
class Journal:
    """Every suggestion, the owner's fills and exits, and what skipped ones would have made."""

    def __init__(self, path=DB):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS suggestions(id TEXT PRIMARY KEY, ts REAL, ticker TEXT, kind TEXT, '
                       'expiry TEXT, data TEXT, status TEXT, entry REAL, exit REAL, pnl REAL, closed_ts REAL, shadow_pnl REAL)')
            # What it made managed by its rules (target, stop, 3:45pm), and how it ended.
            columns = {r[1] for r in db.execute('PRAGMA table_info(suggestions)')}
            for column, kind in (('managed_pnl', 'REAL'), ('managed_how', 'TEXT')):
                if column not in columns:
                    db.execute(f'ALTER TABLE suggestions ADD COLUMN {column} {kind}')
            # Each day's 1-minute prices (Cboe only serves today's), for multi-day replays.
            db.execute('CREATE TABLE IF NOT EXISTS bars(ticker TEXT, minute TEXT, price REAL, PRIMARY KEY(ticker, minute))')

    def _rows(self, where: str = '1=1', args=()):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(f'SELECT * FROM suggestions WHERE {where} ORDER BY ts', args)]

    def add(self, candidate: dict) -> str:
        # The same trade suggested again within 15 minutes is the same suggestion
        # (a Dot asking twice must not count it twice in the results).
        def same(legs):
            return [(leg['action'], leg['type'], leg['strike']) for leg in legs]
        for row in self._rows("kind=? AND ticker=? AND expiry=? AND ts>? AND status='suggested'",
                              (candidate['kind'], candidate['ticker'], candidate['expiry'], time.time() - 900)):
            if same(json.loads(row['data'])['legs']) == same(candidate['legs']):
                return row['id']
        identity = uuid.uuid4().hex[:8]
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO suggestions(id, ts, ticker, kind, expiry, data, status) VALUES(?,?,?,?,?,?,?)',
                       (identity, time.time(), candidate['ticker'], candidate['kind'], candidate['expiry'],
                        json.dumps(candidate), 'suggested'))
        return identity

    def record(self, identity: str, status: str, price: float | None = None) -> dict:
        """The owner's action: 'taken' at a fill price, 'closed' at an exit price, or 'skipped'.
        Prices per share, as the broker shows them (credit positive, debit as paid)."""
        rows = self._rows('id=?', (identity,))
        if not rows:
            raise LookupError(f'No suggestion {identity}.')
        row = rows[0]
        data = json.loads(row['data'])
        if status == 'taken':
            if price is None:
                raise ValueError('Give the fill price.')
            update = {'status': 'open', 'entry': price}
        elif status == 'closed':
            if row['status'] != 'open' or price is None:
                raise ValueError('Only an open trade can be closed, with its exit price.')
            sign = 1 if data['price'] > 0 else -1  # Credit trades profit when the price falls.
            pnl = (row['entry'] - price) * 100 * data['qty'] if sign > 0 else (price - row['entry']) * 100 * data['qty']
            pnl -= 2 * FEE * len(data['legs']) * data['qty']
            update = {'status': 'closed', 'exit': price, 'pnl': round(pnl, 2), 'closed_ts': time.time()}
        elif status == 'skipped':
            update = {'status': 'skipped'}
        else:
            raise ValueError('status is taken, closed or skipped.')
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(f'UPDATE suggestions SET {", ".join(f"{k}=?" for k in update)} WHERE id=?', (*update.values(), identity))
        return {**row, **update}

    def open_trades(self) -> list[dict]:
        return self._rows("status='open'")

    def loss_today(self, et: datetime) -> float:
        start = datetime(et.year, et.month, et.day).timestamp() - 6 * 3600  # Generous: covers the time zone gap.
        return -sum(r['pnl'] for r in self._rows("status='closed' AND closed_ts>=?", (start,)) if r['pnl'] < 0)

    def settle(self, closes: dict) -> int:
        """What each expired suggestion would have made held to expiry, from the
        underlying's closing price that day: {ticker: {date: close}}."""
        settled = 0
        for row in self._rows("shadow_pnl IS NULL"):
            close = (closes.get(row['ticker']) or {}).get(row['expiry'])
            if close is None:
                continue
            data = json.loads(row['data'])
            value = 0.0
            for leg in data['legs']:
                worth = max(close - leg['strike'], 0) if leg['type'] == 'call' else max(leg['strike'] - close, 0)
                value += worth if leg['action'] == 'buy' else -worth
            pnl = (value + data['price']) * 100 * data['qty'] - 2 * FEE * len(data['legs']) * data['qty']
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('UPDATE suggestions SET shadow_pnl=? WHERE id=?', (round(pnl, 2), row['id']))
            settled += 1
        return settled

    def save_bars(self, ticker: str, bars: list[dict]) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executemany('INSERT OR REPLACE INTO bars VALUES(?,?,?)',
                           [(ticker, b['time'].strftime('%Y-%m-%d %H:%M'), b['price']) for b in bars])

    def load_bars(self, ticker: str, start: date, end: date) -> list[dict]:
        with closing(sqlite3.connect(self.path)) as db:
            rows = db.execute('SELECT minute, price FROM bars WHERE ticker=? AND minute>=? AND minute<? ORDER BY minute',
                              (ticker, start.isoformat(), (end + timedelta(days=1)).isoformat())).fetchall()
        return [{'time': datetime.strptime(m, '%Y-%m-%d %H:%M'), 'price': p} for m, p in rows]

    def settle_managed(self, et: datetime, ivs: dict | None = None) -> int:
        """Each finished suggestion's result managed by its rules: closed at its
        profit target, its stop or 3:45pm on expiry day, whichever came first,
        else held to the end. Needs the saved minute bars from entry to expiry."""
        settled = 0
        for row in self._rows('managed_pnl IS NULL'):
            data = json.loads(row['data'])
            expiry = date.fromisoformat(row['expiry'])
            if expiry > et.date() or (expiry == et.date() and et.hour < 16):
                continue  # Still running.
            entered = eastern(datetime.fromtimestamp(row['ts'], timezone.utc))
            bars = self.load_bars(row['ticker'], entered.date(), expiry)
            if not bars or bars[-1]['time'].date() != expiry or bars[-1]['time'].hour * 60 + bars[-1]['time'].minute < 15 * 60 + 45:
                continue  # Missing days (OpenDots was off): left unscored rather than guessed.
            result = track(data, entered, bars, ivs)
            exit_ = result['managed_exit']
            pnl, how = (exit_['pnl'], exit_['event']) if exit_ else (result['now_pnl'], 'held to the end')
            if pnl is None:
                continue
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('UPDATE suggestions SET managed_pnl=?, managed_how=? WHERE id=?', (pnl, how, row['id']))
            settled += 1
        return settled

    def summary(self) -> dict:
        """Per kind: how many were suggested and taken, the owner's real P&L, and the
        managed results (win rate, average win and loss, profit per trade); credit
        spreads are scored against the 80% win-rate target."""
        kinds: dict = {}
        for row in self._rows():
            k = kinds.setdefault(row['kind'], {'suggested': 0, 'taken': 0, 'real_pnl': 0.0, 'wins': [], 'losses': []})
            k['suggested'] += 1
            if row['status'] in ('open', 'closed'):
                k['taken'] += 1
            k['real_pnl'] = round(k['real_pnl'] + (row['pnl'] or 0), 2)
            if row['managed_pnl'] is not None:
                (k['wins'] if row['managed_pnl'] > 0 else k['losses']).append(row['managed_pnl'])
        for name, k in kinds.items():
            wins, losses = k.pop('wins'), k.pop('losses')
            scored = len(wins) + len(losses)
            k['scored'] = scored
            if scored:
                k['win_rate'] = round(len(wins) / scored, 3)
                k['avg_win'] = round(sum(wins) / len(wins), 2) if wins else 0
                k['avg_loss'] = round(sum(losses) / len(losses), 2) if losses else 0
                k['profit_per_trade'] = round((sum(wins) + sum(losses)) / scored, 2)
                k['total'] = round(sum(wins) + sum(losses), 2)
            if name in CREDIT_KINDS:
                k['target'] = (f'80% wins with profit: {"met" if scored and k["win_rate"] >= MIN_POP and k["profit_per_trade"] > 0 else "not yet"}'
                               + (f' ({scored} scored; ~100 needed to trust it)' if scored < 100 else ''))
        return kinds


# Replaying a suggestion -----------------------------------------------------
def track(data: dict, entered: datetime, bars: list[dict], ivs: dict | None = None) -> dict:
    """What a suggestion would have made, minute by minute, if taken at its
    price when suggested: each leg revalued (Black-Scholes) from the underlying's
    1-minute price, its implied volatility and the time left. A model of the
    option prices, not their recorded quotes, so real fills differ by cents.
    bars: [{'time': New York datetime, 'price': float}]; ivs: {symbol: iv} for
    legs logged without one."""
    ivs = ivs or {}
    expiry = date.fromisoformat(data['expiry'])
    credit = data['price'] > 0
    fees = 2 * FEE * len(data['legs']) * data['qty']  # Open and close.
    entry = abs(data['price'])
    # Profit target and stop, as each suggestion's management line says.
    target = 0.35 * entry if data['days'] == 0 else 0.45 * entry  # Credit kept.
    def mark_at(bar, scale=1.0):
        """What closing would cost (credit) or bring (debit) per share at this bar."""
        years = max((datetime(expiry.year, expiry.month, expiry.day, 16) - bar['time']).total_seconds(), 0) / (365 * 24 * 3600)
        value = 0.0
        for leg in data['legs']:
            vol = (leg.get('iv') or ivs.get(leg.get('symbol')) or 0.2) * scale
            worth = float(bs_price(bar['price'], leg['strike'], years, vol, leg['type'] == 'call'))
            value += worth if leg['action'] == 'buy' else -worth
        return -value if credit else value

    live = [bar for bar in bars if bar['time'] >= entered]
    # Calibrate to the suggested price: the volatility level at which the model
    # prices the trade at exactly its entry price at entry, so it then decays to
    # its true value at expiry (a flat shift never let far spreads decay).
    scale, offset = 1.0, 0.0
    if live:
        lo, hi = 0.05, 8.0
        if (mark_at(live[0], lo) - entry) * (mark_at(live[0], hi) - entry) < 0:
            for _ in range(50):
                mid = (lo + hi) / 2
                if (mark_at(live[0], mid) < entry) == (mark_at(live[0], lo) < entry):
                    lo = mid
                else:
                    hi = mid
            scale = (lo + hi) / 2
        else:
            offset = entry - mark_at(live[0])  # Out of reach by volatility: fall back to a shift.
    points, events = [], []
    for bar in live:
        mark = max(mark_at(bar, scale) + offset, 0)
        pnl = ((entry - mark) if credit else (mark - entry)) * 100 * data['qty'] - fees
        points.append({'time': bar['time'].strftime('%H:%M'), 'price': round(bar['price'], 2),
                       'mark': round(mark, 3), 'pnl': round(pnl, 2)})
        seen = {e['event'] for e in events}
        hit = None
        if credit:
            if 'profit target' not in seen and entry - mark >= target:
                hit = 'profit target'
            elif 'stop' not in seen and mark >= 2 * entry:
                hit = 'stop'
        elif 'profit target' not in seen and (mark >= LOTTO_TARGET if data['kind'] == 'lotto' else mark >= 1.5 * entry):
            hit = 'profit target'
        if not hit and 'time exit 3:45pm' not in seen and bar['time'].date() == expiry and \
                bar['time'].hour * 60 + bar['time'].minute >= 15 * 60 + 45 and data['kind'] != 'lotto':
            hit = 'time exit 3:45pm'  # Never into the final minutes on expiry day.
        if hit:
            events.append({'event': hit, 'time': points[-1]['time'], 'day': bar['time'].strftime('%m-%d'),
                           'pnl': points[-1]['pnl']})
    first = events[:1]  # Events are in time order: the first is how it would have been closed.
    return {'kind': data['kind'], 'ticker': data['ticker'], 'expiry': data['expiry'], 'entry': data['price'],
            'entered': entered.strftime('%H:%M'), 'points': points,
            'now_pnl': points[-1]['pnl'] if points else None,
            'best_pnl': max((p['pnl'] for p in points), default=None),
            'worst_pnl': min((p['pnl'] for p in points), default=None),
            'events': events, 'managed_exit': first[0] if first else None,
            'note': 'Modeled from the underlying price and implied volatility, not recorded option quotes.'}


def minute_bars(ticker: str, getter=fetch) -> list[dict]:
    """Today's 1-minute closes as [{'time': New York datetime, 'price'}]."""
    return [{'time': datetime.fromisoformat(b['datetime']), 'price': b['price']['close']}
            for b in getter(f'charts/intraday/{ticker}.json').get('data', [])]


# Tools for the Dots ---------------------------------------------------------
FINDERS = {'credit': credit_spreads, 'debit': debit_spreads, 'lotto': lottos}


def suggest(journal: Journal, ticker: str = '', kinds: str = 'credit,debit,lotto', getter=fetch, et=None) -> dict:
    et = et or now_eastern()
    if not market_open(et):
        return {'suggestions': [], 'note': 'The market is closed (9:30am-4pm New York, weekdays).'}
    if journal.open_trades():
        return {'suggestions': [], 'open': [r['id'] for r in journal.open_trades()],
                'note': 'One trade at a time: a trade is open. Manage it (options_review) before a new one.'}
    lost = journal.loss_today(et)
    if lost >= DAILY_LOSS_LIMIT:
        return {'suggestions': [], 'note': f'Daily loss limit reached (${lost:.0f} of ${DAILY_LOSS_LIMIT:.0f}): no new trades today.'}
    found = []
    for name in [t.strip().upper() for t in (ticker or ','.join(TICKERS)).split(',') if t.strip()]:
        m = market(name, getter)
        for kind in [k.strip() for k in kinds.split(',') if k.strip() in FINDERS]:
            for candidate in FINDERS[kind](m):
                candidate['id'] = journal.add(candidate)
                candidate['quote_time'] = m['asof'].strftime('%H:%M New York (delayed ~15 min)')
                found.append(candidate)
    found.sort(key=lambda c: c['ev'] / max(c['max_loss'], 1), reverse=True)
    found = found[:6]
    plain = [f"{i}. [{c['id']}] {c['kind']}, {c['ticker']} expiring {c['expiry']}: {c['why']} Max loss ${c['max_loss']:.0f}. "
             f"{c['manage']}{' ' + c['warning'] if c.get('warning') else ''}" for i, c in enumerate(found, 1)]
    return {'say_to_owner': '\n'.join(plain) or 'Nothing fits the rules right now.', 'suggestions': found, 'loss_today': lost,
            'note': ('Quotes are delayed ~15 minutes: check the live price on Robinhood before setting up. '
                     'The owner presses the order button; record the fill with options_record.')}


def register(tool, journal: Journal | None = None, getter=fetch) -> None:
    journal = journal or Journal()

    @tool()
    def options_market(ticker: str = 'SPY') -> dict:
        """Market picture for SPY, QQQ or TSLA: price, implied vs forecast volatility,
        today's expected move and the intraday trend (Cboe, delayed ~15 min)."""
        m = market(ticker, getter)
        return {'ticker': m['ticker'], 'price': m['price'], 'asof': m['asof'].strftime('%Y-%m-%d %H:%M New York'),
                'iv30': round(m['iv30'], 3), 'forecast_vol': round(m['forecast_vol'] or 0, 3),
                'seller_edge': ('implied above forecast: premium sellers have the edge' if m['forecast_vol'] and m['iv30'] > m['forecast_vol']
                                else 'implied at or below forecast: little edge selling premium'),
                'expected_move_today': m['expected_move_today'], 'trend': m['trend']}

    @tool()
    def options_suggest(ticker: str = '', kinds: str = 'credit,debit,lotto') -> dict:
        """Find trades within the owner's rules (SPY/QQQ/TSLA, up to 14 days out,
        defined risk, $100 max loss, $40 for debit spreads and lottos, one trade at
        a time, $60 daily loss limit). kinds: credit, debit, lotto. Each comes
        with its odds, expected value, why, and how to manage it, and is logged.
        Never place the order: set it up on the broker and hand off to the owner."""
        return suggest(journal, ticker, kinds, getter)

    @tool()
    def options_record(suggestion_id: str, status: str, price: float | None = None) -> dict:
        """Record what the owner did with a suggestion: status 'taken' with the fill
        price, 'closed' with the exit price, or 'skipped'. Prices per share."""
        return journal.record(suggestion_id, status, price)

    @tool()
    def options_track(suggestion_id: str) -> dict:
        """What a logged suggestion would have made if taken when suggested, minute by
        minute through today (modeled from the underlying's price): now, best and worst
        P&L, and when it would have hit its profit target or stop."""
        rows = journal._rows('id=?', (suggestion_id,))
        if not rows:
            raise LookupError(f'No suggestion {suggestion_id}.')
        data = json.loads(rows[0]['data'])
        chain = parse_chain(getter(f'options/{data["ticker"]}.json'))
        ivs = {o['symbol']: o['iv'] for o in chain['options']}
        result = track(data, eastern(datetime.fromtimestamp(rows[0]['ts'], timezone.utc)), minute_bars(data['ticker'], getter), ivs)
        points = result.pop('points')
        result['samples'] = points[::max(1, len(points) // 12)]  # A dozen points is enough to read.
        return result

    @tool()
    def options_review() -> dict:
        """Open trades, today's loss against the limit, and results by kind: the
        owner's real P&L, and every suggestion's managed result (win rate against
        the 80% target for credit spreads, average win and loss, profit per trade)."""
        closes, ivs = {}, {}
        for ticker in TICKERS:
            try:
                closes[ticker] = {d['date']: d['close'] for d in getter(f'charts/historical/{ticker}.json', 3600)['data'][-30:]}
                journal.save_bars(ticker, minute_bars(ticker, getter))  # Keep today's prices for later replays.
                ivs.update({o['symbol']: o['iv'] for o in parse_chain(getter(f'options/{ticker}.json'))['options']})
            except Exception:
                pass
        journal.settle(closes)
        et = now_eastern()
        journal.settle_managed(et, ivs)
        return {'open': journal.open_trades(), 'loss_today': journal.loss_today(et),
                'daily_limit': DAILY_LOSS_LIMIT, 'by_kind': journal.summary(),
                'note': 'win_rate and profit_per_trade are managed results (profit target, stop, 3:45pm exit). '
                        'Run this after the close each day: it also saves the day\'s prices for replays.'}
