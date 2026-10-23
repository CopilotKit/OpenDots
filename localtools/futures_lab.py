"""Futures lab: do any simple strategies make money on micro S&P (MES) and micro
Nasdaq (MNQ) futures after costs? Backtest only - no account needed.

Data: Yahoo Finance, MES=F / MNQ=F: ~2.4 years of hourly bars (overnight sessions
included) and ~60 days of 5-minute bars. One contract, MES $5 a point, MNQ $2 a point,
tick 0.25. Costs per round trip at three levels (tastytrade micros, roughly):
  limit  - fees only, about $3 (fills at our price, if they fill);
  market - fees + a tick of slippage each way;
  harsh  - fees + two ticks each way.
Strategies (exits tuned on the first two thirds of the days, judged on the rest):
  1. overnight hold: buy at the 4pm close, sell next morning (9am hourly open);
  2. day session hold: buy 9am, sell at the 4pm close (the mirror image);
  3. hourly trend: 20/50-hour moving-average crossover (long-only and long/short);
  4. daily RSI(2) dip-buying, out above the 5-day average (Connors);
  5. the edge lab's intraday signals on 5-minute bars, with a target, stop and time limit;
  6. opening-range breakout: the first 30 minutes' range, 5-minute bars.

Run: python futures_lab.py   (writes "Futures Lab.md" to the vault)
"""
from __future__ import annotations

import json
import math
import statistics
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from itertools import product
from pathlib import Path

import edge_lab
import options_guide as og

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'futures'
REPORT = Path('C:/Users/inter/Desktop/MainAINotes/Site Maps/Futures/Futures Lab.md')
CONTRACTS = {'MES': {'symbol': 'MES=F', 'point': 5.0}, 'MNQ': {'symbol': 'MNQ=F', 'point': 2.0}}
TICK = 0.25
FEES = 3.0  # Per round trip, all in.
COSTS = {'limit': 0, 'market': 1, 'harsh': 2}  # Ticks of slippage each way.
SPLIT = 2 / 3


def download(symbol: str, interval: str, span: str) -> list[dict]:
    """Bars in New York time: [{'t', 'o', 'h', 'l', 'c', 'v'}], cached for 12 hours."""
    import requests
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f'{symbol.replace("=", "")}-{interval}.json'
    if path.exists() and time.time() - path.stat().st_mtime < 12 * 3600:
        raw = json.loads(path.read_text())
    else:
        r = requests.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}&range={span}',
                         timeout=60, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        r.raise_for_status()
        raw = r.json()
        path.write_text(json.dumps(raw))
    res = raw['chart']['result'][0]
    q = res['indicators']['quote'][0]
    bars = []
    for i, stamp in enumerate(res['timestamp']):
        values = [q[k][i] for k in ('open', 'high', 'low', 'close', 'volume')]
        if None in values:
            continue
        t = og.eastern(datetime.fromtimestamp(stamp, timezone.utc).replace(tzinfo=None))  # Daylight saving handled.
        bars.append({'t': t, 'o': values[0], 'h': values[1], 'l': values[2], 'c': values[3], 'v': values[4] or 0})
    return bars


def dollars(points: float, contract: str, cost: str) -> float:
    """One contract's profit after fees and slippage."""
    return points * CONTRACTS[contract]['point'] - FEES - 2 * COSTS[cost] * TICK * CONTRACTS[contract]['point']


def stats(trades: list[float]) -> dict:
    if not trades:
        return {'n': 0}
    wins = [t for t in trades if t > 0]
    mean = sum(trades) / len(trades)
    sd = statistics.pstdev(trades) or 1.0
    return {'n': len(trades), 'win_rate': round(len(wins) / len(trades), 3), 'per_trade': round(mean, 2),
            'total': round(sum(trades), 2), 'z': round(mean / (sd / math.sqrt(len(trades))), 2)}


# Hourly strategies ------------------------------------------------------------------
def sessions_hourly(bars: list[dict]) -> dict:
    """Per trading date: the 9am open and the 4pm close (from hourly bars)."""
    days = defaultdict(dict)
    for b in bars:
        d = b['t'].date().isoformat()
        if b['t'].hour == 9:
            days[d]['open'] = b['o']
        if b['t'].hour == 15:
            days[d]['close'] = b['c']
    return {d: v for d, v in sorted(days.items()) if 'open' in v and 'close' in v and datetime.fromisoformat(d).weekday() < 5}


def overnight_and_day(bars):
    days = sessions_hourly(bars)
    names = list(days)
    night = [(names[k], days[names[k]]['open'] - days[names[k - 1]]['close']) for k in range(1, len(names))]
    day = [(d, days[d]['close'] - days[d]['open']) for d in names]
    return {'Overnight hold (buy 4pm close, sell 9am)': night, 'Day session hold (buy 9am, sell 4pm close)': day}


def trend(bars, fast=20, slow=50, long_only=True):
    closes = [b['c'] for b in bars]
    def ema(n):
        k, out, e = 2 / (n + 1), [], closes[0]
        for c in closes:
            e = c * k + e * (1 - k)
            out.append(e)
        return out
    f, s = ema(fast), ema(slow)
    trades, position, entry, entry_day = [], 0, 0.0, None
    for i in range(slow, len(bars)):
        want = 1 if f[i] > s[i] else (0 if long_only else -1)
        if want != position:
            if position:
                trades.append((entry_day, (closes[i] - entry) * position))
            position, entry, entry_day = want, closes[i], bars[i]['t'].date().isoformat()
    return trades


def rsi2(bars):
    days = sessions_hourly(bars)
    names = list(days)
    closes = [days[d]['close'] for d in names]
    trades, holding, entry, entry_day = [], False, 0.0, None
    for k in range(5, len(closes)):
        gains = [max(closes[j] - closes[j - 1], 0) for j in range(k - 1, k + 1)]
        losses = [max(closes[j - 1] - closes[j], 0) for j in range(k - 1, k + 1)]
        rs = (sum(gains) / 2) / max(sum(losses) / 2, 1e-9)
        value = 100 - 100 / (1 + rs)
        if not holding and value < 10:
            holding, entry, entry_day = True, closes[k], names[k]
        elif holding and closes[k] > statistics.mean(closes[k - 4:k + 1]):
            trades.append((entry_day, closes[k] - entry))
            holding = False
    return trades


# 5-minute strategies -------------------------------------------------------------------
def rth_sessions(bars):
    days = defaultdict(list)
    for b in bars:
        if 9 * 60 + 30 <= b['t'].hour * 60 + b['t'].minute < 16 * 60 and b['t'].weekday() < 5:
            days[b['t'].date().isoformat()].append(b)
    return {d: v for d, v in sorted(days.items()) if len(v) >= 70}


def run_trade(day, i, up, target, stop, hold):
    """Enter at the next bar's open; exit at target/stop (stop first if both in a bar) or after `hold` bars."""
    if i + 1 >= len(day):
        return None
    entry = day[i + 1]['o']
    for j in range(i + 1, min(i + 1 + hold, len(day))):
        b = day[j]
        if up:
            if b['l'] <= entry - stop:
                return -stop
            if b['h'] >= entry + target:
                return target
        else:
            if b['h'] >= entry + stop:
                return -stop
            if b['l'] <= entry - target:
                return target
    last = day[min(i + hold, len(day) - 1)]['c']
    return (last - entry) if up else (entry - last)


def edge_signals(days, scale):
    """The edge lab's signals -> {name: {(target, stop, hold): [(day, points)]}}."""
    found = defaultdict(lambda: defaultdict(list))
    history, previous = [], None
    for name, day in days.items():
        for i, signal, up in edge_lab.signals(day, previous, history[-120:]):
            for t_mult, s_mult, hold in product((1, 2, 3), (1, 2), (6, 12)):
                pts = run_trade(day, i, up, t_mult * scale, s_mult * scale, hold)
                if pts is not None:
                    found[signal][(t_mult * scale, s_mult * scale, hold)].append((name, pts))
        history += [b['c'] for b in day]
        previous = day[-1]['c']
    return found


def opening_range(days, scale):
    found = defaultdict(list)
    for name, day in days.items():
        rng = day[:6]  # 9:30-10:00.
        hi, lo = max(b['h'] for b in rng), min(b['l'] for b in rng)
        width = hi - lo
        for i in range(6, len(day) - 1):
            b = day[i]
            up = b['c'] > hi
            if up or b['c'] < lo:
                for target_r in (1.0, 2.0):
                    pts = run_trade(day, i, up, target_r * width, width, len(day))
                    if pts is not None:
                        found[(target_r, width)].append((name, pts))
                break
    by_target = defaultdict(list)
    for (target_r, _), trades in found.items():
        by_target[target_r] += trades
    return by_target


# The lab ------------------------------------------------------------------------------
def judge(name, contract, trades_by_rule, all_days):
    """Choose the rule (exit) on the first two thirds of the days, judge on the rest, at three cost levels."""
    cut = all_days[int(len(all_days) * SPLIT)] if all_days else ''
    best_rule, best = None, -1e9
    for rule, trades in trades_by_rule.items():
        train = [dollars(p, contract, 'market') for d, p in trades if d < cut]
        if len(train) >= 20 and sum(train) / len(train) > best:
            best_rule, best = rule, sum(train) / len(train)
    if best_rule is None:
        return None
    trades = trades_by_rule[best_rule]
    out = {'strategy': name, 'contract': contract, 'rule': str(best_rule), 'cut': cut}
    for cost in COSTS:
        out[f'train_{cost}'] = stats([dollars(p, contract, cost) for d, p in trades if d < cut])
        out[f'test_{cost}'] = stats([dollars(p, contract, cost) for d, p in trades if d >= cut])
    out['edge'] = bool(out['train_market'].get('per_trade', -1) > 0 and out['test_market'].get('per_trade', -1) > 0
                       and out['test_market'].get('n', 0) >= 20)
    return out


def run(log=print) -> list[dict]:
    results = []
    for contract, spec in CONTRACTS.items():
        hourly = download(spec['symbol'], '1h', '730d')
        five = download(spec['symbol'], '5m', '60d')
        hourly_days = sorted({b['t'].date().isoformat() for b in hourly})
        log(f'{contract}: {len(hourly)} hourly bars ({hourly_days[0]} to {hourly_days[-1]}), {len(five)} 5-minute bars')
        for name, trades in overnight_and_day(hourly).items():
            results.append(judge(name, contract, {'always': trades}, hourly_days))
        results.append(judge('Hourly trend 20/50, long only', contract, {'20/50': trend(hourly)}, hourly_days))
        results.append(judge('Hourly trend 20/50, long and short', contract, {'20/50': trend(hourly, long_only=False)}, hourly_days))
        results.append(judge('Daily RSI(2) dip-buying', contract, {'rsi2<10': rsi2(hourly)}, hourly_days))
        days = rth_sessions(five)
        names = list(days)
        # Target/stop scale: a typical 5-minute range.
        scale = round(statistics.median(b['h'] - b['l'] for d in days.values() for b in d) * 2) / 2 or 1.0
        for signal, by_exit in edge_signals(days, scale).items():
            results.append(judge(f'Intraday: {signal} (5-min)', contract, by_exit, names))
        results.append(judge('Opening-range breakout (first 30 min)', contract, opening_range(days, scale), names))
    return [r for r in results if r]


def report(results: list[dict]) -> str:
    def cell(s):
        return f'{s["n"]} / {s["win_rate"]:.0%} / ${s["per_trade"]:+.2f} (z {s["z"]:+.1f})' if s.get('n') else '-'
    lines = ['---', 'tags:', '  - "futures"', '  - "backtest"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Futures Lab', '',
             'Micro S&P (MES, $5 a point) and micro Nasdaq (MNQ, $2 a point), one contract. Yahoo data: about 2.4 '
             'years of hourly bars (overnight included) and 60 days of 5-minute bars. Exits chosen on the first two '
             'thirds of the days, judged on the rest. Dollars per trade after costs: "limit" = fees only (~$3 a '
             'round trip), "market" = plus a tick each way. z above about 2 is unlikely to be luck.', '',
             '| Strategy | Contract | Rule | Train (market): trades / wins / $ a trade | Test (market) | Test (limit) | Edge? |',
             '|---|---|---|---|---|---|---|',
             *[f'| {r["strategy"]} | {r["contract"]} | {r["rule"]} | {cell(r["train_market"])} | {cell(r["test_market"])} | '
               f'{cell(r["test_limit"])} | {"**yes**" if r["edge"] else "no"} |'
               for r in sorted(results, key=lambda r: -r["test_market"].get("per_trade", -999))], '',
             '## Read with care', '',
             '- 5-minute strategies have only ~60 days; the hourly ones ~2.4 years (one mostly rising market).',
             '- Fills at the bar\'s open and stop-before-target inside a bar are approximations.',
             '- A strategy here is a candidate for tastytrade\'s paper (sandbox) account, not for money.',
             '', 'Run again: `python localtools/futures_lab.py`.']
    return '\n'.join(lines) + '\n'


def long_history(stop_pct=None, trend_filter=False, notional=5 * 6900.0, cost=5.50) -> dict:
    """RSI(2) dip-buying on SPY's daily bars since 1993 (tracks the S&P like MES), in
    percentage moves on one MES contract of today's size: bear markets included, which the
    futures' own 2.4 years lack. trend_filter: buy dips only above the 200-day average.
    Returns trades by year: {year: [dollars]}."""
    import requests
    r = requests.get('https://query1.finance.yahoo.com/v8/finance/chart/SPY',
                     params={'period1': 725846400, 'period2': int(time.time()), 'interval': '1d'},  # Daily, not range=max (monthly).
                     timeout=60, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    res = r.json()['chart']['result'][0]
    q = res['indicators']['quote'][0]
    bars = [(datetime.fromtimestamp(ts, timezone.utc).date(), q['open'][i], q['low'][i], q['close'][i])
            for i, ts in enumerate(res['timestamp']) if q['open'][i] and q['close'][i] and q['low'][i]]
    closes = [b[3] for b in bars]
    out, holding, entry = defaultdict(list), False, 0.0
    for k in range(200, len(bars)):
        d, o, low, c = bars[k]
        if holding:
            stop = entry * (1 - stop_pct) if stop_pct else None
            if stop and low <= stop:
                out[d.year].append((min(o, stop) / entry - 1) * notional - cost)
                holding = False
            elif c > statistics.mean(closes[k - 4:k + 1]):
                out[d.year].append((c / entry - 1) * notional - cost)
                holding = False
            continue
        gains = [max(closes[j] - closes[j - 1], 0) for j in (k - 1, k)]
        losses = [max(closes[j - 1] - closes[j], 0) for j in (k - 1, k)]
        rsi = 100 - 100 / (1 + (sum(gains) / 2) / max(sum(losses) / 2, 1e-9))
        if rsi < 10 and (not trend_filter or c > statistics.mean(closes[k - 199:k + 1])):
            holding, entry = True, c
    return dict(out)


if __name__ == '__main__':
    results = run()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(report(results), encoding='utf-8')
    (ROOT / 'data' / 'futures-lab.json').write_text(json.dumps(results, indent=1, default=str))
    for r in sorted(results, key=lambda r: -r['test_market'].get('per_trade', -999)):
        print(f'{r["contract"]} {r["strategy"]:50s} {r["rule"]:22s} train {r["train_market"]} | test {r["test_market"]} | '
              f'{"EDGE" if r["edge"] else ""}')
