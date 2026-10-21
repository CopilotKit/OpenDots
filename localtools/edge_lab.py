"""Edge lab: tests intraday signals on SPY, QQQ and TSLA as option trades, before
any of them is trusted with money.

Each signal, when it fires on a 5-minute close (10:00am-3:15pm New York), buys
a debit spread in its direction and sells it ("flips the value") at a profit
target, a stop or a time limit, whichever comes first. A daily 10:30am credit
spread managed by the owner's credit rules is the baseline to beat. Option
prices are modeled (Black-Scholes) from the VIX scaled to each ticker's own
recent volatility, with slippage and fees; real fills differ.

Honest testing: exits are tuned on the first two thirds of the days and the
signal is judged only on the last third, which it never saw.

Run: python edge_lab.py   (writes the edge list to the Obsidian vault)
"""
from __future__ import annotations

import json
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from trading_feed import ema, macd_histogram, rsi

TICKERS = {'SPY': 1.0, 'QQQ': 1.0, 'TSLA': 2.5}  # Spread width (strike step).
CACHE = Path(__file__).parent.parent / 'data' / 'edge-lab'
REPORT = Path(os.environ.get('LOCALTOOLS_SITE_MAPS') or Path(__file__).parent.parent / 'data' / 'site-maps') / 'Robinhood' / 'Edge Lab.md'
SLIPPAGE = 0.03  # Per spread, per side: crossing the bid/ask.
FEE = 0.03  # Per contract per side.
TARGETS = (0.25, 0.5, 1.0)  # Profit target as a share of the debit.
STOPS = (0.3, 0.5)  # Stop as a share of the debit lost.
HOLDS = (6, 12)  # Time limit in 5-minute bars (30 or 60 minutes).


# Data ---------------------------------------------------------------------
def download(symbol: str, max_age_h: float = 12) -> dict:
    """60 days of 5-minute bars from Yahoo Finance, cached on disk."""
    import requests
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{symbol.replace('^', '')}-5m.json"
    if path.exists() and time.time() - path.stat().st_mtime < max_age_h * 3600:
        return json.loads(path.read_text())
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol.replace("^", "%5E")}?interval=5m&range=60d'
    response = requests.get(url, timeout=30, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    response.raise_for_status()
    path.write_text(response.text)
    return response.json()


def sessions(document: dict) -> dict[str, list[dict]]:
    """Regular-hours bars per day, in New York time: {date: [{t, o, h, l, c, v}]}."""
    result = document['chart']['result'][0]
    offset = result['meta'].get('gmtoffset', -14400)
    quote = result['indicators']['quote'][0]
    days: dict[str, list[dict]] = defaultdict(list)
    for i, stamp in enumerate(result['timestamp']):
        bar = {k: quote[name][i] for k, name in (('o', 'open'), ('h', 'high'), ('l', 'low'), ('c', 'close'), ('v', 'volume'))}
        if any(v is None for v in bar.values()):
            continue
        t = datetime.fromtimestamp(stamp, timezone.utc).replace(tzinfo=None) + timedelta(seconds=offset)
        if 9 * 60 + 30 <= t.hour * 60 + t.minute < 16 * 60:
            days[t.strftime('%Y-%m-%d')].append({'t': t, **bar})
    return dict(sorted(days.items()))


# Pricing ------------------------------------------------------------------
def bs(spot: float, strike: float, years: float, vol: float, call: bool) -> float:
    if years <= 0 or vol <= 0:
        return max(spot - strike, 0) if call else max(strike - spot, 0)
    root = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + 0.5 * vol * vol * years) / root
    d2 = d1 - root
    n = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return spot * n(d1) - strike * n(d2) if call else strike * n(-d2) - spot * n(-d1)


def years_left(t: datetime, expiry: datetime) -> float:
    return max((expiry - t).total_seconds(), 0) / (365 * 24 * 3600)


def spread_value(spot, t, expiry, vol, up: bool, k1: float, k2: float) -> float:
    """A debit spread's value: long k1, short k2 (calls for up, puts for down)."""
    years = years_left(t, expiry)
    return bs(spot, k1, years, vol, up) - bs(spot, k2, years, vol, up)


def expiry_for(ticker: str, day: datetime) -> datetime:
    """SPY and QQQ list options every weekday (same-day expiry); TSLA on Fridays."""
    close = day.replace(hour=16, minute=0, second=0, microsecond=0)
    if ticker == 'TSLA':
        return close + timedelta(days=(4 - close.weekday()) % 7)
    return close


# Signals ------------------------------------------------------------------
def signals(day: list[dict], previous_close: float | None, history: list[float]) -> list[tuple[int, str, bool]]:
    """(bar index, signal name, up?) for every signal on one day. `history` is the
    closes before today, so indicators are warmed up at the open."""
    out = []
    closes = [b['c'] for b in day]
    opening = day[:6]  # 9:30-10:00.
    if len(day) < 12:
        return out
    or_high, or_low = max(b['h'] for b in opening), min(b['l'] for b in opening)
    cum_pv = cum_v = 0.0
    vwap = []
    for b in day:
        cum_pv += (b['h'] + b['l'] + b['c']) / 3 * b['v']
        cum_v += b['v']
        vwap.append(cum_pv / cum_v if cum_v else b['c'])
    fired = set()
    for i in range(6, len(day)):
        if not (10 * 60 <= day[i]['t'].hour * 60 + day[i]['t'].minute <= 15 * 60 + 15):
            continue
        window = (history + closes[:i + 1])[-120:]
        c = closes[i]

        def once(name, up):
            if (name, up) not in fired:  # Each signal at most once a day per direction.
                fired.add((name, up))
                out.append((i, name, up))

        if c > or_high and closes[i - 1] <= or_high:
            once('opening range breakout', True)
        if c < or_low and closes[i - 1] >= or_low:
            once('opening range breakout', False)
        if c > vwap[i] and all(x < v for x, v in zip(closes[i - 3:i], vwap[i - 3:i])):
            once('VWAP reclaim', True)
        if c < vwap[i] and all(x > v for x, v in zip(closes[i - 3:i], vwap[i - 3:i])):
            once('VWAP rejection', False)
        e9, e21 = ema(window, 9), ema(window, 21)
        if e9[-1] > e21[-1] and day[i]['l'] <= e21[-1] < c:
            once('trend pullback', True)
        if e9[-1] < e21[-1] and day[i]['h'] >= e21[-1] > c:
            once('trend pullback', False)
        now, before = rsi(window), rsi(window[:-1])
        if now is not None and before is not None:
            if before < 30 <= now:
                once('RSI snap-back', True)
            if before > 70 >= now:
                once('RSI snap-back', False)
        hist = macd_histogram(window)
        if len(hist) >= 2 and (hist[-1] > 0) != (hist[-2] > 0):
            up = hist[-1] > 0
            once('MACD cross', up)
            recent = [v for v in (rsi(window[:len(window) - k]) for k in range(4)) if v is not None]
            if recent and ((up and min(recent) <= 30) or (not up and max(recent) >= 70)):
                once('MACD cross + RSI 30/70', up)
        if i == 6 and previous_close:
            gap = day[0]['o'] / previous_close - 1
            if abs(gap) >= 0.003 and (c - previous_close) * gap > 0:  # Still gapped at 10:00: fade toward the prior close.
                once('gap fade', gap < 0)
    return out


# Trades -------------------------------------------------------------------
def debit_trade(day, i, ticker, up, vol, target, stop, hold) -> float | None:
    """P&L in dollars of one debit spread bought at bar i's close and sold at the
    target, the stop, the time limit or 3:45pm, whichever first."""
    width = TICKERS[ticker]
    spot = day[i]['c']
    expiry = expiry_for(ticker, day[i]['t'])
    k1 = round(spot / width) * width  # At the money.
    k2 = k1 + width if up else k1 - width
    entry = spread_value(spot, day[i]['t'], expiry, vol, up, k1, k2) + SLIPPAGE
    if entry < 0.05:
        return None
    for j in range(i + 1, min(i + 1 + hold, len(day))):
        t = day[j]['t']
        worth = spread_value(day[j]['c'], t, expiry, vol, up, k1, k2) - SLIPPAGE
        last = j == i + hold or t.hour * 60 + t.minute >= 15 * 60 + 45 or j == len(day) - 1
        if worth >= entry * (1 + target) or worth <= entry * (1 - stop) or last:
            return (worth - entry) * 100 - 4 * FEE
    return None


def credit_baseline(day, ticker, vol) -> list[tuple[str, float]]:
    """A same-day put and call credit spread opened at 10:30 at about 0.15 delta,
    managed by the owner's credit rules (35% target, 2x stop, 3:45pm exit)."""
    out = []
    if ticker == 'TSLA':
        return out  # TSLA's strike step makes these too big for the budget.
    i = next((k for k, b in enumerate(day) if b['t'].hour == 10 and b['t'].minute == 30), None)
    if i is None:
        return out
    spot, t0 = day[i]['c'], day[i]['t']
    expiry = expiry_for(ticker, t0)
    move = spot * vol * math.sqrt(years_left(t0, expiry))
    for up in (False, True):  # Put spread below, call spread above.
        short = round(spot - 1.0 * move) if not up else round(spot + 1.0 * move)
        long = short - 1 if not up else short + 1
        value = lambda s, t: bs(s, short, years_left(t, expiry), vol, up) - bs(s, long, years_left(t, expiry), vol, up)
        credit = value(spot, t0) - SLIPPAGE
        if credit < 0.05:
            continue
        pnl = None
        for j in range(i + 1, len(day)):
            t = day[j]['t']
            cost = value(day[j]['c'], t) + SLIPPAGE
            if credit - cost >= 0.35 * credit or cost >= 2 * credit or t.hour * 60 + t.minute >= 15 * 60 + 45:
                pnl = (credit - cost) * 100 - 4 * FEE
                break
        if pnl is not None:
            out.append(('daily credit spread ' + ('call' if up else 'put') + ' side', pnl))
    return out


def stats(pnls: list[float]) -> dict:
    if not pnls:
        return {'n': 0}
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    return {'n': len(pnls), 'win_rate': len(wins) / len(pnls), 'per_trade': sum(pnls) / len(pnls),
            'avg_win': sum(wins) / len(wins) if wins else 0.0, 'avg_loss': sum(losses) / len(losses) if losses else 0.0,
            'total': sum(pnls)}


# The lab ------------------------------------------------------------------
def run(documents: dict | None = None) -> dict:
    documents = documents or {s: download(s) for s in (*TICKERS, '^VIX')}
    vix = {d: [b['c'] for b in bars] for d, bars in sessions(documents['^VIX']).items()}
    found: dict[str, dict] = defaultdict(lambda: defaultdict(list))  # name -> (target, stop, hold) -> [(day, pnl)]
    baseline: dict[str, list] = defaultdict(list)
    all_days = sorted({d for s in TICKERS for d in sessions(documents[s])})
    split = all_days[int(len(all_days) * 2 / 3)] if all_days else ''
    for ticker in TICKERS:
        days = sessions(documents[ticker])
        history: list[float] = []
        daily_closes: list[float] = []
        previous = None
        for name_day, day in days.items():
            # Volatility: the VIX that morning, scaled by this ticker's realized
            # volatility against SPY's (TSLA moves about twice as much).
            vix_now = (vix.get(name_day) or [None])[min(6, len(vix.get(name_day) or [0]) - 1)] if vix.get(name_day) else None
            if vix_now is None or len(daily_closes) < 10:
                daily_closes.append(day[-1]['c'])
                history += [b['c'] for b in day]
                previous = day[-1]['c']
                continue
            vol = vix_now / 100 * ratio(ticker, documents, name_day)
            for i, name, up in signals(day, previous, history[-120:]):
                for target in TARGETS:
                    for stop in STOPS:
                        for hold in HOLDS:
                            pnl = debit_trade(day, i, ticker, up, vol, target, stop, hold)
                            if pnl is not None:
                                found[name][(target, stop, hold)].append((name_day, pnl))
            for name, pnl in credit_baseline(day, ticker, vol):
                baseline[name].append((name_day, pnl))
            daily_closes.append(day[-1]['c'])
            history += [b['c'] for b in day]
            previous = day[-1]['c']
    results = []
    for name, by_exit in found.items():
        # Tune the exit on the early days, judge it on the later ones only.
        best = max(by_exit, key=lambda k: stats([p for d, p in by_exit[k] if d < split]).get('per_trade', -1e9))
        train = stats([p for d, p in by_exit[best] if d < split])
        test = stats([p for d, p in by_exit[best] if d >= split])
        results.append({'signal': name, 'exit': {'target': best[0], 'stop': best[1], 'minutes': best[2] * 5},
                        'train': train, 'test': test})
    for name, trades in baseline.items():
        results.append({'signal': name, 'exit': 'credit rules (35% target, 2x stop, 3:45pm)',
                        'train': stats([p for d, p in trades if d < split]), 'test': stats([p for d, p in trades if d >= split])})
    results.sort(key=lambda r: r['test'].get('per_trade', -1e9), reverse=True)
    return {'days': len(all_days), 'first': all_days[0] if all_days else None, 'last': all_days[-1] if all_days else None,
            'split': split, 'results': results}


_ratios: dict = {}


def ratio(ticker: str, documents: dict, day: str) -> float:
    """This ticker's 20-day realized volatility over SPY's, up to `day`."""
    if ticker == 'SPY':
        return 1.0
    key = (ticker, day)
    if key not in _ratios:
        def realized(symbol):
            closes = [bars[-1]['c'] for d, bars in sessions(documents[symbol]).items() if d < day][-21:]
            if len(closes) < 10:
                return None
            returns = np.diff(np.log(closes))
            return float(returns.std(ddof=1))
        own, spy = realized(ticker), realized('SPY')
        _ratios[key] = own / spy if own and spy else 1.0
    return _ratios[key]


def report(lab: dict) -> str:
    lines = ['---', 'tags:', '  - "trading"', '  - "edge-lab"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Edge Lab', '',
             f"{lab['days']} trading days of 5-minute bars ({lab['first']} to {lab['last']}). Exits tuned on the days "
             f"before {lab['split']}; **judged only on the days from {lab['split']}** (the test columns).", '',
             'Each signal buys a debit spread in its direction and sells it at the profit target, the stop or the time '
             'limit. Modeled prices (VIX-based volatility, $0.03 slippage a side, fees); real fills differ.', '',
             '| Signal | Exit | Test trades | Test win rate | Test $/trade | Avg win / loss | Train $/trade |',
             '|---|---|---|---|---|---|---|']
    for r in lab['results']:
        exit_ = r['exit'] if isinstance(r['exit'], str) else f"+{r['exit']['target']:.0%} / -{r['exit']['stop']:.0%} / {r['exit']['minutes']} min"
        t, tr = r['test'], r['train']
        if not t.get('n'):
            continue
        lines.append(f"| {r['signal']} | {exit_} | {t['n']} | {t['win_rate']:.0%} | {t['per_trade']:+.2f} | "
                     f"{t['avg_win']:+.2f} / {t['avg_loss']:+.2f} | {tr.get('per_trade', 0):+.2f} |")
    lines += ['', 'An edge counts only if test $/trade is positive with enough trades (30+), and train agrees.']
    return '\n'.join(lines) + '\n'


def report_with_costs() -> str:
    """The edge list at three cost levels: costs decide whether an edge survives."""
    global SLIPPAGE, FEE
    parts, keep = [], (SLIPPAGE, FEE)
    for slip, fee, label in ((0.03, 0.03, 'Market-style fills ($0.03 slippage a side)'),
                             (0.01, 0.03, 'Limit orders near the mid ($0.01 slippage a side)'),
                             (0.0, 0.0, 'No costs (the signal alone)')):
        SLIPPAGE, FEE = slip, fee
        _ratios.clear()
        text = report(run())
        body = text.split('| Signal |', 1)[1]
        parts.append(f'## {label}\n\n| Signal |{body}')
    SLIPPAGE, FEE = keep
    intro = text.split('| Signal |', 1)[0]
    return intro + '\n'.join(parts)


if __name__ == '__main__':
    text = report_with_costs()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(text, encoding='utf-8')
    print(text)
