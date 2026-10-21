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
        # The site stamps prices in its own clock (2 hours ahead of this PC on
        # 2026-10-18); expiry checks must use that clock, not time.time().
        self.offset = 0.0

    def now(self) -> float:
        """The current time in the feed's own clock."""
        return time.time() + self.offset

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
                    self.offset = float(row[1]) - time.time()
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


def macd_histogram(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> list[float]:
    """MACD line minus its signal line for each candle once there are `slow` closes."""
    if len(closes) < slow:
        return []
    line = [a - b for a, b in zip(ema(closes, fast), ema(closes, slow))]
    sig = ema(line[slow - 1:], signal)
    return [m - s for m, s in zip(line[slow - 1:], sig)]


def reversal_signal(closes: list[float], within: int = 3, held: int = 5) -> dict | None:
    """A change of direction: the MACD line crossing its signal line in the last
    `within` candles and still on the new side (bearish: from above to below). With
    RSI beyond 70 (bearish) or 30 (bullish) in the last few candles it is a
    reversal, the strongest tell; a cross alone is a weaker one. The lines must
    have held the other way for `held` candles first: in a flat, choppy market
    they cross back and forth, which tells nothing."""
    hist = macd_histogram(closes)
    if len(hist) < within + held + 1:
        return None
    for ago in range(within):
        now, before = hist[-1 - ago], hist[-2 - ago]
        if (now > 0) != (before > 0):
            break
    else:
        return None
    if any((v > 0) == (now > 0) for v in hist[-2 - ago - held + 1:len(hist) - 1 - ago]):
        return None  # Not a turn after a run one way: just chop.
    up = hist[-1] > 0
    recent = [v for v in (rsi(closes[:len(closes) - k]) for k in range(within + 2)) if v is not None]
    extreme = (min(recent) <= 30) if up and recent else (max(recent) >= 70) if recent else False
    rsi_now = round(recent[0], 1) if recent else None
    when = 'on the latest candle' if ago == 0 else f'{ago} candle{"s" if ago > 1 else ""} ago'
    why = (f"MACD crossed {'bullish (green over red)' if up else 'bearish (red over green)'} {when}"
           + (f", with RSI {'below 30' if up else 'above 70'} (now {rsi_now})" if extreme else f', RSI {rsi_now}'))
    return {'direction': 'up' if up else 'down', 'kind': 'reversal' if extreme else 'cross', 'why': why}


def bollinger(closes: list[float], length: int = 20, width: float = 2.0) -> list[tuple[float, float, float]]:
    """(middle, upper, lower) bands for each candle from the `length`-th on."""
    out = []
    for i in range(length - 1, len(closes)):
        window = closes[i - length + 1:i + 1]
        mid = sum(window) / length
        sd = (sum((c - mid) ** 2 for c in window) / length) ** 0.5
        out.append((mid, mid + width * sd, mid - width * sd))
    return out


def band_turn(bars: list[dict], within: int = 3) -> dict | None:
    """Price at a Bollinger band while that band curves over: it touched the upper
    band in the last `within` candles and the band, rising over the candles before,
    now rises less steeply or turns down (a turn down coming); or the mirror at the
    lower band."""
    bands = bollinger([b['c'] for b in bars])
    if len(bands) < within + 4:
        return None
    upper = [b[1] for b in bands]
    lower = [b[2] for b in bands]
    recent = bars[-within:]
    touched_up = any(bar['h'] >= upper[-within + j] for j, bar in enumerate(recent))
    touched_low = any(bar['l'] <= lower[-within + j] for j, bar in enumerate(recent))
    up_now, up_before = upper[-1] - upper[-2], (upper[-3] - upper[-6]) / 3  # Slope now vs the run before.
    low_now, low_before = lower[-1] - lower[-2], (lower[-3] - lower[-6]) / 3
    if touched_up and up_before > 0 and up_now < up_before:
        return {'direction': 'down', 'why': 'price touched the upper Bollinger band and the band is curving over'}
    if touched_low and low_before < 0 and low_now > low_before:
        return {'direction': 'up', 'why': 'price touched the lower Bollinger band and the band is curving up'}
    return None


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


def regroup(bars: list[dict], period: int) -> list[dict]:
    """Smaller candles combined into candles of `period` seconds."""
    out: list[dict] = []
    for b in bars:
        start = int(b['t'] // period) * period
        if out and out[-1]['t'] == start:
            c = out[-1]
            c['h'], c['l'], c['c'] = max(c['h'], b['h']), min(c['l'], b['l']), b['c']
        else:
            out.append({'t': start, 'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c']})
    return out


def chart_bars(feed: PriceFeed, key: str, period: int) -> list[dict]:
    """Candles of `period` seconds from whichever source has more: the ticks
    (about 11 minutes after a pair switch) or the ready-made candles the site
    sends with them (89 of the chart's 30 s candles, about 44 minutes), combined
    to this size. Ticks alone give only ~11 one-minute candles, too few for RSI."""
    best = candles(feed.ticks.get(key) or (), period)
    for size in sorted((feed.candle_sets.get(key) or {}), reverse=True):
        if size <= period and period % size == 0:
            ready = regroup(feed.candles_for(key, size), period)
            if len(ready) > len(best):
                best = ready
    return best


def read_chart(feed: PriceFeed, key: str, period: int, show: int = 12) -> dict:
    """Candles and indicators for one asset, plus the setup used by the journal."""
    bars = chart_bars(feed, key, period)
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
    signal = reversal_signal(closes)
    turn = band_turn(bars)
    if turn:
        out['bollinger'] = turn['why']
    if signal and signal['kind'] == 'reversal' and turn and turn['direction'] == signal['direction']:
        # The full picture: MACD crossing, RSI beyond 70/30 and the band curving over.
        signal = {**signal, 'kind': 'top', 'why': f"{signal['why']}; {turn['why']}"}
    if signal:
        out['signal'] = signal
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
    """Direction and clarity: a fresh MACD cross sets the direction (score 15;
    30 with RSI beyond 70/30, a reversal and the strongest tell). Otherwise 'up' or
    'down' only when RSI, MACD and the EMA slope agree, the score growing with
    RSI's distance from 50, but held below 'very high' when RSI is already beyond
    70/30 in the trend's direction, where a turn is likely."""
    value, state, slope = chart.get('rsi14'), chart.get('macd_state', ''), chart.get('ema9_slope')
    if value is None or not state:
        return {'direction': 'warming up', 'score': -1}
    signal = chart.get('signal')
    if signal:
        return {'direction': signal['direction'], 'score': {'top': 40, 'reversal': 30}.get(signal['kind'], 15),
                'signal': signal['kind'], 'why': signal['why']}
    if value >= 55 and state.startswith('bullish') and slope == 'up':
        direction = 'up'
    elif value <= 45 and state.startswith('bearish') and slope == 'down':
        direction = 'down'
    else:
        return {'direction': 'no clear trend', 'score': 0}
    score = round(abs(value - 50) + (10 if 'strengthening' in state or 'crossed' in state else 0), 1)
    if (direction == 'up' and value >= 70) or (direction == 'down' and value <= 30):
        score = min(score, 15)  # Stretched: no 'very high' for chasing it.
    return {'direction': direction, 'score': score}


class TradeJournal:
    """Every trade with its setup at entry and its result after expiry."""

    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, asset TEXT, direction TEXT, stake REAL, '
                       'expiry_s INTEGER, entry_ts REAL, entry_price REAL, setup TEXT, result TEXT, exit_price REAL)')
            # Results from Pocket Option's own closed-deal messages: the deal's id, its
            # profit, and where the result came from ('site', or 'estimate' from ticks).
            have = {row[1] for row in db.execute('PRAGMA table_info(trades)')}
            for column, kind in (('deal_id', 'TEXT'), ('profit', 'REAL'), ('source', 'TEXT')):
                if column not in have:
                    db.execute(f'ALTER TABLE trades ADD COLUMN {column} {kind}')
        # Seconds to wait past expiry for the site's result before estimating one
        # from ticks; set once the site's deal messages are seen.
        self.site_grace = 0.0

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
            db.execute('INSERT INTO trades(id, asset, direction, stake, expiry_s, entry_ts, entry_price, setup) '
                       'VALUES(?,?,?,?,?,?,?,?)',
                       (trade, asset, direction, stake, expiry_s, entry_ts, entry_price, json.dumps(setup)))
        return trade

    def settle(self, feed: PriceFeed, now: float | None = None) -> int:
        """Estimate results of expired trades from the price feed (BUY wins above
        entry) when the site's own result has not arrived within `site_grace`."""
        now = now or feed.now()
        settled = 0
        with self._db() as db:
            rows = db.execute('SELECT id, asset, direction, expiry_s, entry_ts, entry_price FROM trades '
                              'WHERE result IS NULL AND expiry_s IS NOT NULL AND entry_price IS NOT NULL').fetchall()
            for trade, asset, direction, expiry, entry_ts, entry in rows:
                if entry_ts + expiry + self.site_grace > now:
                    continue
                exit_price = feed.price_at(asset_key(asset), entry_ts + expiry)
                if exit_price is None:
                    if now - (entry_ts + expiry) > 3600:
                        db.execute("UPDATE trades SET result='unknown' WHERE id=?", (trade,))
                    continue
                up = direction == 'buy'
                result = 'tie' if exit_price == entry else 'win' if (exit_price > entry) == up else 'loss'
                db.execute("UPDATE trades SET result=?, exit_price=?, source='estimate' WHERE id=?", (result, exit_price, trade))
                settled += 1
        return settled

    def apply_deals(self, deals) -> int:
        """Results from Pocket Option's closed deals ({asset, amount, command 0 = BUY,
        openTimestamp, openPrice, closePrice, profit}), matched to recorded trades
        by pair, stake, direction and open time. These replace any estimate: on a
        night of 11-second trades the estimates said break-even while the
        balance fell from $84 to $45."""
        applied = 0
        with self._db() as db:
            for deal in deals if isinstance(deals, list) else []:
                if not isinstance(deal, dict) or not deal.get('closePrice') or 'profit' not in deal:
                    continue
                try:
                    opened, amount, profit = float(deal['openTimestamp']), float(deal['amount']), float(deal['profit'])
                except (KeyError, TypeError, ValueError):
                    continue
                direction = 'buy' if deal.get('command') == 0 else 'sell'
                if db.execute('SELECT 1 FROM trades WHERE deal_id=?', (str(deal.get('id')),)).fetchone():
                    continue
                rows = db.execute("SELECT id, asset, entry_ts FROM trades WHERE direction=? AND ABS(stake - ?) < 0.006 "
                                  "AND ABS(entry_ts - ?) <= 8 AND (source IS NULL OR source != 'site')",
                                  (direction, amount, opened)).fetchall()
                rows = [r for r in rows if asset_key(r[1]) == asset_key(str(deal.get('asset', '')))]
                if not rows:
                    continue
                trade = min(rows, key=lambda r: abs(r[2] - opened))[0]
                result = 'win' if profit > 0 else 'loss' if profit < 0 else 'tie'
                db.execute("UPDATE trades SET result=?, profit=?, entry_price=?, exit_price=?, deal_id=?, source='site' "
                           'WHERE id=?', (result, profit, deal.get('openPrice'), deal.get('closePrice'), str(deal.get('id')), trade))
                applied += 1
        return applied

    def open_trades(self, now: float) -> list[dict]:
        """Trades still running at `now` (feed clock), or just ended and not yet settled."""
        with self._db() as db:
            rows = db.execute('SELECT direction, stake, expiry_s, entry_ts FROM trades WHERE result IS NULL '
                              'AND entry_ts + expiry_s > ? ORDER BY entry_ts', (now - 5 - self.site_grace,)).fetchall()
        return [{'direction': d, 'stake': s, 'expiry_s': e, 'ends': t + e} for d, s, e, t in rows]

    def win_rate(self, last: int = 10) -> tuple[int, int]:
        """Wins and settled trades among the most recent `last`."""
        with self._db() as db:
            rows = db.execute("SELECT result FROM trades WHERE result IN ('win','loss','tie') "
                              'ORDER BY entry_ts DESC LIMIT ?', (last,)).fetchall()
        return sum(1 for (r,) in rows if r == 'win'), len(rows)

    def losing_streak(self, since: float = 0) -> int:
        """Losses in a row among settled trades entered after `since` (feed clock), newest first."""
        with self._db() as db:
            rows = db.execute("SELECT result FROM trades WHERE result IN ('win','loss','tie') AND entry_ts > ? "
                              'ORDER BY entry_ts DESC LIMIT 50', (since,)).fetchall()
        streak = 0
        for (result,) in rows:
            if result != 'loss':
                break
            streak += 1
        return streak

    def last_results(self, count: int, since: float = 0) -> list[tuple[str, float, float | None]]:
        """(result, stake, profit) of the latest settled trades entered after `since`, newest first."""
        with self._db() as db:
            return db.execute("SELECT result, stake, profit FROM trades WHERE result IN ('win','loss','tie') AND entry_ts > ? "
                              'ORDER BY entry_ts DESC LIMIT ?', (since, count)).fetchall()

    def last_closed(self) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT direction, stake, expiry_s, entry_price, exit_price, result FROM trades "
                             "WHERE result IN ('win','loss','tie') ORDER BY entry_ts DESC LIMIT 1").fetchone()
        if not row:
            return None
        d, s, e, entry, exit_price, result = row
        return {'trade': f'{d.upper()} ${s:g} for {e}s', 'result': {'win': 'WON', 'loss': 'LOST', 'tie': 'TIE'}[result],
                'entry_price': entry, 'exit_price': exit_price}

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
            rows = db.execute('SELECT entry_ts, asset, direction, stake, expiry_s, entry_price, exit_price, result, setup, '
                              'profit, source FROM trades ORDER BY entry_ts').fetchall()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', newline='', encoding='utf-8') as handle:
            out = csv.writer(handle)
            out.writerow(['time', 'pair', 'market', 'direction', 'stake', 'expiry_s', 'entry_price', 'exit_price', 'result',
                          'candle_s', 'rsi_zone', 'macd', 'trend_at_entry', 'reason', 'confidence', 'signal',
                          'profit', 'result_from'])
            for ts, asset, direction, stake, expiry, entry, exit_, result, setup, profit, source in rows:
                s = json.loads(setup or '{}')
                out.writerow([time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts)), asset,
                              'OTC' if 'OTC' in (asset or '').upper() else 'real', direction, stake, expiry, entry, exit_,
                              result or 'open', s.get('candle_s'), s.get('rsi_zone'), s.get('macd'), s.get('trend'), s.get('reason', ''),
                              s.get('confidence'), s.get('signal'), profit, source or ''])
        return len(rows)

    def recent(self, limit: int = 20) -> list[dict]:
        with self._db() as db:
            rows = db.execute('SELECT asset, direction, stake, expiry_s, entry_ts, entry_price, exit_price, result, setup '
                              'FROM trades ORDER BY entry_ts DESC LIMIT ?', (limit,)).fetchall()
        return [{'asset': a, 'direction': d, 'stake': s, 'expiry_s': e,
                 'opened': time.strftime('%H:%M:%S', time.localtime(t)), 'entry': p, 'exit': x,
                 'result': r or 'open', 'setup': json.loads(st or '{}')} for a, d, s, e, t, p, x, r, st in rows]
