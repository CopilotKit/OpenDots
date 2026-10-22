"""Live trading prices from the page's own data feed, read by code: candles,
RSI and MACD computed exactly, and a journal of trades with their results, so
the Dots decide from measurements and from what actually worked instead of
from a vision model's impression of a screenshot.

Pocket Option streams ticks as binary WebSocket frames like
[["GBPJPY_otc", 1792288207.653, 211.345]]; nothing here sends anything."""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
import time
import uuid
from collections import deque
from pathlib import Path


def asset_key(name: str) -> str:
    """'GBP/JPY OTC', 'GBPJPY_otc' and '#AAPL_otc' all become 'GBPJPYOTC' / 'AAPLOTC'."""
    return re.sub(r'[^A-Z0-9]', '', (name or '').upper())


class PriceFeed:
    """Ticks per asset from feed frames, kept for a few hours."""

    def __init__(self, keep: int = 30000):
        self.ticks: dict[str, deque] = {}
        self.names: dict[str, str] = {}
        self.keep = keep
        # Ready-made candles sent on a chart timeframe change, per asset and
        # candle size: {key: {period_s: (received_at, bars)}}.
        self.candle_sets: dict[str, dict[int, tuple[float, list[dict]]]] = {}

    def add_frame(self, text: str) -> int:
        """Store the ticks in one decoded frame; returns how many were added."""
        if text and text[0] == '{' and '"asset"' in text and ('"history"' in text or '"candles"' in text):
            return self.add_history(text)
        if not text or text[0] != '[':
            return 0
        try:
            data = json.loads(text)
        except ValueError:
            return 0
        added = 0
        for row in data if isinstance(data, list) else []:
            if (isinstance(row, list) and len(row) >= 3 and isinstance(row[0], str)
                    and isinstance(row[1], (int, float)) and isinstance(row[2], (int, float))):
                key = asset_key(row[0])
                self.names[key] = row[0]
                ticks = self.ticks.setdefault(key, deque(maxlen=self.keep))
                if not ticks or row[1] >= ticks[-1][0]:
                    ticks.append((float(row[1]), float(row[2])))
                    added += 1
        return added

    def add_history(self, text: str) -> int:
        """Recent prices sent when a chart switches pair, e.g.
        {"asset":"GBPJPY_otc","period":30,"history":[[1792339064.071,213.865], ...]}:
        about ten minutes of ticks, enough for RSI and MACD at once."""
        try:
            data = json.loads(text)
        except ValueError:
            return 0
        if not isinstance(data, dict) or not isinstance(data.get('asset'), str):
            return 0
        key = asset_key(data['asset'])
        added = 0
        bars = bars_from_candles(data.get('candles')) if isinstance(data.get('candles'), list) else []
        if len(bars) >= 2:
            steps = sorted(b['t'] - a['t'] for a, b in zip(bars, bars[1:]) if b['t'] > a['t'])
            period = steps[len(steps) // 2] if steps else 0
            if period > 0:
                self.names[key] = data['asset']
                self.candle_sets.setdefault(key, {})[int(period)] = (time.time(), bars)
                added = len(bars)
        if not isinstance(data.get('history'), list):
            return added
        rows = sorted((float(r[0]), float(r[1])) for r in data['history']
                      if isinstance(r, list) and len(r) >= 2 and all(isinstance(v, (int, float)) for v in r[:2]))
        if not rows:
            return added
        self.names[key] = data['asset']
        newer = [t for t in self.ticks.get(key, ()) if t[0] > rows[-1][0]]
        self.ticks[key] = deque(rows + newer, maxlen=self.keep)
        return len(rows)

    def candles_for(self, key: str, period: int, max_age: float = 1800) -> list[dict]:
        """Ready-made candles of this size received in the last `max_age`
        seconds, with newer ticks folded into the last candle, or []."""
        received, bars = (self.candle_sets.get(key) or {}).get(int(period), (0, []))
        if not bars or time.time() - received > max_age:
            return []
        bars = [dict(b) for b in bars]
        for ts, price in self.ticks.get(key) or ():
            if ts < bars[-1]['t']:
                continue
            start = int(ts // period * period)
            if start >= bars[-1]['t'] + period:
                bars.append({'t': start, 'o': price, 'h': price, 'l': price, 'c': price})
            last = bars[-1]
            last['h'], last['l'], last['c'] = max(last['h'], price), min(last['l'], price), price
        return bars

    def last(self, key: str):
        ticks = self.ticks.get(key)
        return ticks[-1] if ticks else None

    def price_at(self, key: str, when: float):
        """The last price at or before `when`, if the feed covers that moment."""
        ticks = self.ticks.get(key) or ()
        before = None
        for ts, price in ticks:
            if ts > when:
                return before[1] if before else None
            before = (ts, price)
        return None  # Not yet past `when`.


def candles(ticks, period: int) -> list[dict]:
    """OHLC candles of `period` seconds from (time, price) ticks."""
    out: list[dict] = []
    for ts, price in ticks:
        start = int(ts // period) * period
        if out and out[-1]['t'] == start:
            c = out[-1]
            c['h'] = max(c['h'], price); c['l'] = min(c['l'], price); c['c'] = price
        else:
            out.append({'t': start, 'o': price, 'h': price, 'l': price, 'c': price})
    return out


def ema(values: list[float], span: int) -> list[float]:
    if not values:
        return []
    k = 2 / (span + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes: list[float], length: int = 14) -> float | None:
    """Wilder's RSI; None until there are length + 1 closes."""
    if len(closes) <= length:
        return None
    gains = [max(closes[i] - closes[i - 1], 0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0) for i in range(1, len(closes))]
    avg_gain = sum(gains[:length]) / length
    avg_loss = sum(losses[:length]) / length
    for g, l in zip(gains[length:], losses[length:]):
        avg_gain = (avg_gain * (length - 1) + g) / length
        avg_loss = (avg_loss * (length - 1) + l) / length
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9):
    """(macd, signal, histogram, previous histogram); None until `slow` closes."""
    if len(closes) < slow:
        return None
    line = [a - b for a, b in zip(ema(closes, fast), ema(closes, slow))]
    sig = ema(line[slow - 1:], signal)
    hist = [m - s for m, s in zip(line[slow - 1:], sig)]
    return line[-1], sig[-1], hist[-1], hist[-2] if len(hist) > 1 else None


def rsi_zone(value: float | None) -> str:
    if value is None:
        return 'unknown'
    return 'oversold <30' if value < 30 else 'low 30-50' if value < 50 else 'high 50-70' if value < 70 else 'overbought >70'


def bars_from_candles(rows) -> list[dict]:
    """Ready-made candles as Pocket Option sends them on a timeframe change,
    [time, open, close, high, low, ticks] (newest first), as bars oldest first."""
    bars = [{'t': int(r[0]), 'o': float(r[1]), 'c': float(r[2]), 'h': float(r[3]), 'l': float(r[4])}
            for r in rows if isinstance(r, list) and len(r) >= 5 and all(isinstance(v, (int, float)) for v in r[:5])]
    return sorted(bars, key=lambda b: b['t'])


def read_chart(feed: PriceFeed, key: str, period: int, show: int = 12) -> dict:
    """Candles and indicators for one asset, plus the setup used by the journal."""
    bars = candles(feed.ticks.get(key) or (), period)
    if not bars:
        return {'asset': feed.names.get(key, key), 'period_s': period, 'candles': 0,
                'note': 'No prices received for this asset yet; the feed fills while the chart page is open.'}
    return read_bars(bars, feed.names.get(key, key), period, show)


def read_bars(bars: list[dict], name: str, period: int, show: int = 12) -> dict:
    """Indicators on candles, from ticks or from ready-made candles."""
    closes = [b['c'] for b in bars]
    if not bars:
        return {'asset': name, 'period_s': period, 'candles': 0, 'note': 'No candles.'}
    value = rsi(closes)
    m = macd(closes)
    recent = bars[-show:]
    colours = ''.join('G' if b['c'] > b['o'] else 'R' if b['c'] < b['o'] else '-' for b in recent)
    trend = ema(closes, 9)
    slope = (trend[-1] - trend[-4]) if len(trend) >= 4 else 0
    out = {
        'asset': name, 'period_s': period, 'candles': len(bars),
        'last_price': closes[-1],
        'recent_candles': colours + '  (oldest to newest; G up, R down; the last one is still forming)',
        'rsi14': round(value, 1) if value is not None else None, 'rsi_zone': rsi_zone(value),
        'ema9_slope': 'up' if slope > 0 else 'down' if slope < 0 else 'flat',
    }
    if m:
        line, sig, hist, before = m
        out.update(macd=round(line, 6), macd_signal=round(sig, 6), macd_histogram=round(hist, 6),
                   macd_state=('bullish' if hist > 0 else 'bearish') + (
                       ', crossed just now' if before is not None and (before > 0) != (hist > 0)
                       else ', strengthening' if before is not None and abs(hist) > abs(before) else ', weakening'))
    if value is None or not m:
        need = 27 if not m else 15
        out['note'] = (f'Warming up: {len(bars)} candles of {period}s so far; RSI needs 15 and MACD 27. '
                       'Use a shorter candle period or wait.')
    out['setup'] = {'rsi_zone': out['rsi_zone'],
                    'macd': out.get('macd_state', 'unknown').split(',')[0],
                    'last3_up': colours[-4:-1].count('G') if len(colours) >= 4 else None}
    return out


STANDARD_CANDLES = (5, 15, 30, 60, 120, 300, 900, 1800, 3600)


def candle_period(expiry_s: int) -> int:
    """Candle size for a trade length: about a quarter of the expiry, on the
    usual chart steps (11 s -> 5 s, 1 min -> 15 s, 5 min -> 1 min, 1 h -> 15 min)."""
    fitting = [c for c in STANDARD_CANDLES if c <= max(expiry_s, 5) / 4]
    return fitting[-1] if fitting else 5


def pair_trend(chart: dict) -> dict:
    """Trend clarity for the pair scanner: 'up' or 'down' only when RSI, MACD
    and the EMA slope agree; the score grows with RSI's distance from 50."""
    value, state, slope = chart.get('rsi14'), chart.get('macd_state', ''), chart.get('ema9_slope')
    if value is None or not state:
        return {'direction': 'warming up', 'score': -1}
    if value >= 55 and state.startswith('bullish') and slope == 'up':
        direction = 'up'
    elif value <= 45 and state.startswith('bearish') and slope == 'down':
        direction = 'down'
    else:
        return {'direction': 'no clear trend', 'score': 0}
    return {'direction': direction, 'score': round(abs(value - 50) + (10 if 'strengthening' in state or 'crossed' in state else 0), 1)}


class TradeJournal:
    """Every trade with its setup at entry and its result after expiry."""

    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, asset TEXT, direction TEXT, stake REAL, '
                       'expiry_s INTEGER, entry_ts REAL, entry_price REAL, setup TEXT, result TEXT, exit_price REAL)')

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path)
        try:
            with db:  # Commits, or rolls back on error.
                yield db
        finally:
            db.close()

    def record(self, asset: str, direction: str, stake, expiry_s, entry_ts: float, entry_price, setup: dict) -> str:
        trade = str(uuid.uuid4())
        with self._db() as db:
            db.execute('INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',
                       (trade, asset, direction, stake, expiry_s, entry_ts, entry_price, json.dumps(setup)))
        return trade

    def settle(self, feed: PriceFeed, now: float | None = None) -> int:
        """Fill in results of expired trades from the price feed (BUY wins above entry)."""
        now = now or time.time()
        settled = 0
        with self._db() as db:
            rows = db.execute('SELECT id, asset, direction, expiry_s, entry_ts, entry_price FROM trades '
                              'WHERE result IS NULL AND expiry_s IS NOT NULL AND entry_price IS NOT NULL').fetchall()
            for trade, asset, direction, expiry, entry_ts, entry in rows:
                if entry_ts + expiry > now:
                    continue
                exit_price = feed.price_at(asset_key(asset), entry_ts + expiry)
                if exit_price is None:
                    if now - (entry_ts + expiry) > 3600:
                        db.execute("UPDATE trades SET result='unknown' WHERE id=?", (trade,))
                    continue
                up = direction == 'buy'
                result = 'tie' if exit_price == entry else 'win' if (exit_price > entry) == up else 'loss'
                db.execute('UPDATE trades SET result=?, exit_price=? WHERE id=?', (result, exit_price, trade))
                settled += 1
        return settled

    def record_for(self, direction: str | None, setup: dict | None, limit: int = 500) -> dict:
        """Win counts overall, recently, and in setups like this one, per direction."""
        with self._db() as db:
            rows = db.execute("SELECT direction, setup, result FROM trades WHERE result IN ('win','loss','tie') "
                              'ORDER BY entry_ts DESC LIMIT ?', (limit,)).fetchall()
        def score(items):
            wins = sum(1 for r in items if r == 'win')
            return f'{wins} won of {len(items)}' if items else 'no trades yet'
        out = {'all': score([r for _, _, r in rows]), 'last_10': score([r for _, _, r in rows[:10]])}
        if setup:
            alike = [(d, r) for d, s, r in rows if (json.loads(s or '{}').get('rsi_zone'), json.loads(s or '{}').get('macd'))
                     == (setup.get('rsi_zone'), setup.get('macd'))]
            for side in ('buy', 'sell'):
                out[f'{side}_in_this_setup'] = score([r for d, r in alike if d == side])
        return out

    def summary(self, limit: int = 2000) -> dict:
        """Win rates by market (OTC or real), expiry, trend at entry and setup,
        for studying which reasoning works."""
        with self._db() as db:
            rows = db.execute("SELECT asset, direction, expiry_s, setup, result FROM trades WHERE result IN ('win','loss','tie') "
                              'ORDER BY entry_ts DESC LIMIT ?', (limit,)).fetchall()
        groups: dict[str, dict[str, list]] = {'market': {}, 'expiry': {}, 'trend_at_entry': {}, 'setup': {}, 'direction': {}}
        for asset, direction, expiry, setup, result in rows:
            s = json.loads(setup or '{}')
            keys = {'market': 'OTC' if 'OTC' in (asset or '').upper() else 'real market',
                    'expiry': f'{expiry}s' if expiry and expiry < 60 else f'{(expiry or 0) // 60}m',
                    'trend_at_entry': s.get('trend') or 'unknown',
                    'setup': f"RSI {s.get('rsi_zone', '?')}, MACD {s.get('macd', '?')}",
                    'direction': direction}
            for group, key in keys.items():
                groups[group].setdefault(key, []).append(result == 'win')
        def rate(wins):
            return f'{sum(wins)} won of {len(wins)} ({round(100 * sum(wins) / len(wins))}%)'
        return {'all': rate([r == 'win' for *_, r in rows]) if rows else 'no settled trades yet',
                **{group: {k: rate(v) for k, v in sorted(items.items(), key=lambda kv: -len(kv[1]))} for group, items in groups.items()}}

    def export_csv(self, path) -> int:
        """Every trade, one row each, for opening in Excel."""
        import csv
        with self._db() as db:
            rows = db.execute('SELECT entry_ts, asset, direction, stake, expiry_s, entry_price, exit_price, result, setup '
                              'FROM trades ORDER BY entry_ts').fetchall()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', newline='', encoding='utf-8') as handle:
            out = csv.writer(handle)
            out.writerow(['time', 'pair', 'market', 'direction', 'stake', 'expiry_s', 'entry_price', 'exit_price', 'result',
                          'candle_s', 'rsi_zone', 'macd', 'trend_at_entry', 'reason'])
            for ts, asset, direction, stake, expiry, entry, exit_, result, setup in rows:
                s = json.loads(setup or '{}')
                out.writerow([time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts)), asset,
                              'OTC' if 'OTC' in (asset or '').upper() else 'real', direction, stake, expiry, entry, exit_,
                              result or 'open', s.get('candle_s'), s.get('rsi_zone'), s.get('macd'), s.get('trend'), s.get('reason', '')])
        return len(rows)

    def recent(self, limit: int = 20) -> list[dict]:
        with self._db() as db:
            rows = db.execute('SELECT asset, direction, stake, expiry_s, entry_ts, entry_price, exit_price, result, setup '
                              'FROM trades ORDER BY entry_ts DESC LIMIT ?', (limit,)).fetchall()
        return [{'asset': a, 'direction': d, 'stake': s, 'expiry_s': e,
                 'opened': time.strftime('%H:%M:%S', time.localtime(t)), 'entry': p, 'exit': x,
                 'result': r or 'open', 'setup': json.loads(st or '{}')} for a, d, s, e, t, p, x, r, st in rows]
