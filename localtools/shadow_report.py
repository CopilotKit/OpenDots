"""Shadow test of OTC setups on recorded prices: nothing is traded.

Replays the ticks saved in data/price-ticks.sqlite (see TickRecorder) into 5 s
candles and, on every closed candle, checks three setups, then scores what a
trade at that candle's close would have done after the expiry:

  fade  - the live OTC rule (otc_fade): a candle closing beyond a Bollinger band
  cross - the MACD line crossing its signal line on that candle, after a run the
          other way (reversal_signal); "+RSI" when RSI was beyond 30/70
  tip   - the cross about to happen: the histogram on one side for 5+ candles,
          shrinking two candles running, now within 40% of zero of its recent
          peak, not crossed yet; traded in the direction of the coming cross

Run: python shadow_report.py [--hours 24] [--expiry 8 11]
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from collections import defaultdict
from contextlib import closing
from pathlib import Path

from trading_feed import candles, macd_histogram, otc_fade, reversal_signal, rsi

PERIOD = 5
WINDOW = 150  # Candles behind each reading (live has about 10 minutes = 120).
GAP = 30  # Seconds without prices that split the recording into separate runs.
PAYOUT = 0.92  # Pocket Option OTC payout: a win pays 92%, so break-even is 52.1%.
DB = Path(__file__).parent.parent / 'data' / 'price-ticks.sqlite'


def tip_signal(closes: list[float], held: int = 5, near: float = 0.4) -> dict | None:
    hist = macd_histogram(closes)
    if len(hist) < max(held + 1, 10):
        return None
    now = hist[-1]
    if now == 0 or any((v > 0) != (now > 0) for v in hist[-held - 1:]):
        return None  # Not a run on one side (or it already crossed).
    if not abs(hist[-1]) < abs(hist[-2]) < abs(hist[-3]):
        return None  # Not shrinking towards the cross.
    if abs(now) > near * max(abs(v) for v in hist[-10:]):
        return None  # Still far from crossing.
    up = now < 0  # A bearish run fading: the coming cross is bullish.
    recent = [v for v in (rsi(closes[:len(closes) - k]) for k in range(5)) if v is not None]
    extreme = bool(recent) and (min(recent) <= 30 if up else max(recent) >= 70)
    return {'direction': 'up' if up else 'down', 'rsi': extreme}


def outcome(ticks: list[tuple[float, float]], start: int, entry_t: float, entry: float, up: bool, expiry: int):
    """'win' / 'loss' / 'tie' for a trade at entry_t, or None where the recorded
    prices do not cover the whole trade (a gap of more than 6 s)."""
    last_t, price = entry_t, entry
    for ts, value in ticks[start:]:
        if ts - last_t > 6:
            return None
        if ts > entry_t + expiry:
            break
        last_t, price = ts, value
    else:
        return None  # The recording ends before the expiry.
    if price == entry:
        return 'tie'
    return 'win' if (price > entry) == up else 'loss'


def replay(ticks: list[tuple[float, float]], expiries=(8, 11)) -> list[dict]:
    """Every setup on one asset's ticks with its result at each expiry."""
    found, start = [], 0
    for i in range(1, len(ticks) + 1):
        if i == len(ticks) or ticks[i][0] - ticks[i - 1][0] > GAP:
            found += replay_run(ticks[start:i], expiries)
            start = i
    return found


def replay_run(ticks: list[tuple[float, float]], expiries) -> list[dict]:
    bars = candles(ticks, PERIOD)
    found, last_at = [], {}
    index = 0
    for i in range(30, len(bars) - 1):
        closes = [b['c'] for b in bars[max(0, i + 1 - WINDOW):i + 1]]
        entry_t = bars[i]['t'] + PERIOD
        while index < len(ticks) and ticks[index][0] < entry_t:
            index += 1
        setups = []
        fade = otc_fade(bars[max(0, i + 1 - WINDOW):i + 2])  # Its last bar is the forming one.
        if fade:
            setups.append(('fade', fade['direction'] == 'up'))
        cross = reversal_signal(closes, within=1)
        if cross:
            setups.append(('cross' + (' +RSI' if cross['kind'] == 'reversal' else ''), cross['direction'] == 'up'))
        tip = tip_signal(closes)
        if tip:
            setups.append(('tip' + (' +RSI' if tip['rsi'] else ''), tip['direction'] == 'up'))
        for kind, up in setups:
            family = kind.split()[0]
            if entry_t - last_at.get(family, 0) < max(expiries):
                continue  # One trade per setup at a time, as live.
            last_at[family] = entry_t
            results = {e: outcome(ticks, index, entry_t, bars[i]['c'], up, e) for e in expiries}
            found.append({'kind': kind, 'up': up, 'at': entry_t, **{f'r{e}': r for e, r in results.items()}})
    return found


def report(hours: float = 24, expiries=(8, 11), db: Path = DB) -> str:
    since = time.time() - hours * 3600 + 7200  # Feed clock runs ~2 h ahead; be generous.
    with closing(sqlite3.connect(db)) as conn:
        assets = [a for (a,) in conn.execute('SELECT DISTINCT asset FROM ticks WHERE ts>=?', (since - 7200,)) if a.endswith('OTC')]
        found = []
        for asset in assets:
            ticks = conn.execute('SELECT ts, price FROM ticks WHERE asset=? AND ts>=? ORDER BY ts', (asset, since - 7200)).fetchall()
            for item in replay(ticks, expiries):
                found.append({**item, 'asset': asset})
        total = conn.execute('SELECT COUNT(*) FROM ticks').fetchone()[0]
    lines = [f'{total} recorded ticks, {len(assets)} OTC pairs; break-even at {1 / (1 + PAYOUT):.1%} wins (92% payout).', '']
    for e in expiries:
        lines.append(f'{e} s trades:')
        groups = defaultdict(lambda: {'win': 0, 'loss': 0, 'tie': 0})
        for item in found:
            r = item[f'r{e}']
            if r:
                for key in (item['kind'], f"{item['kind']} {'BUY' if item['up'] else 'SELL'}"):
                    groups[key][r] += 1
        for kind in sorted(groups):
            g = groups[kind]
            n = g['win'] + g['loss']
            if not n:
                continue
            profit = g['win'] * PAYOUT - g['loss']
            lines.append(f"  {kind:<18} {g['win']:>4}-{g['loss']:<4} ({g['win'] / n:.0%}, {g['tie']} ties)  "
                         f"{profit / n:+.2f} per $1 staked")
        lines.append('')
    lines.append('Fewer than ~100 trades in a row is too few to rely on.')
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--hours', type=float, default=24)
    parser.add_argument('--expiry', type=int, nargs='+', default=[8, 11])
    args = parser.parse_args()
    print(report(args.hours, tuple(args.expiry)))
