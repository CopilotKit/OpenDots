"""Scalp simulator: quick "value flips" replayed on the real recorded option quotes
(option_quotes.py), not on modeled prices.

The idea being tested: buy an at-the-money call or put, sell it as soon as its
value pops by a small target (the stock does not have to move much: gamma, a
jump in implied volatility), or cut it at a stop or a time limit, then buy the
next one. Many small wins, one contract at a time.

Fills are the honest ones: buy at the ask, sell at the bid, $0.03 a contract in
fees each way. A limit near the mid can do better but may not fill; this does
not assume it. Quotes are one snapshot a minute, so a pop that comes and goes
inside a minute is missed (fewer target hits than in real life), and a stop is
filled at the first snapshot past it (sometimes worse than the stop).

Honest testing: each rule set is chosen on the first two thirds of the recorded
days and judged on the rest, which the choice never saw.

Run: python scalp_sim.py     (writes Scalp Sim.md to the vault and data/scalp-sim.json)
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from itertools import product
from pathlib import Path

import option_quotes as oq
from options_guide import FEE

TARGETS = (0.02, 0.05, 0.10, 0.20)  # Dollars of option price: $2-$20 a contract.
STOPS = (0.05, 0.10, 0.20, 0.40)
HOLDS = (5, 15, 30)  # Minutes.
SIDES = ('call', 'put')
FIRST_ENTRY, LAST_ENTRY, LAST_EXIT = (9, 31), (15, 30), (15, 45)  # Market time.
SMALL_MOVE = 0.0005  # A stock move under 0.05%: "the price hardly moved".
ROOT = Path(__file__).parent.parent
REPORT = Path(os.environ.get('LOCALTOOLS_SITE_MAPS') or ROOT / 'data' / 'site-maps') / 'Robinhood' / 'Scalp Sim.md'
OUTPUT = ROOT / 'data' / 'scalp-sim.json'


def minutes(t: datetime) -> int:
    return t.hour * 60 + t.minute


def pick(snapshot: dict, call: bool) -> str | None:
    """The at-the-money contract of the nearest expiry with a usable quote."""
    options = [(s, q) for s, q in snapshot['quotes'].items() if q['call'] == call and q['bid'] > 0]
    if not options:
        return None
    nearest = min(q['expiry'] for _, q in options)
    return min((s for s, q in options if q['expiry'] == nearest),
               key=lambda s: abs(snapshot['quotes'][s]['strike'] - snapshot['spot']))


def scalp_day(snaps: list[dict], call: bool, target: float, stop: float, hold: int) -> list[dict]:
    """Back-to-back scalps through one day: enter, exit, enter again at the next snapshot."""
    trades, i = [], 0
    session = [s for s in snaps if FIRST_ENTRY[0] * 60 + FIRST_ENTRY[1] <= minutes(oq.session_time(s['asof']))
               <= LAST_EXIT[0] * 60 + LAST_EXIT[1]]
    while i < len(session):
        entry = session[i]
        t0 = oq.session_time(entry['asof'])
        if minutes(t0) > LAST_ENTRY[0] * 60 + LAST_ENTRY[1]:
            break
        symbol = pick(entry, call)
        if symbol is None:
            i += 1
            continue
        paid = entry['quotes'][symbol]['ask']
        exit_at, how = None, None
        for j in range(i + 1, len(session)):
            quote = session[j]['quotes'].get(symbol)
            if not quote or quote['bid'] <= 0:
                continue  # Missing or empty quote this minute: wait for the next.
            t = oq.session_time(session[j]['asof'])
            if quote['bid'] >= paid + target:
                exit_at, how = j, 'target'
            elif quote['bid'] <= paid - stop:
                exit_at, how = j, 'stop'
            elif (t - t0).total_seconds() >= hold * 60:
                exit_at, how = j, 'time'
            elif minutes(t) >= LAST_EXIT[0] * 60 + LAST_EXIT[1] or j == len(session) - 1:
                exit_at, how = j, 'close'
            if exit_at is not None:
                break
        if exit_at is None:
            break
        out = session[exit_at]
        sold = out['quotes'][symbol]['bid']
        trades.append({'symbol': symbol, 'entered': t0.strftime('%H:%M'),
                       'minutes': round((out['asof'] - entry['asof']).total_seconds() / 60),
                       'paid': paid, 'sold': sold, 'how': how, 'pnl': round((sold - paid) * 100 - 2 * FEE, 2),
                       'spread': round(paid - entry['quotes'][symbol]['bid'], 2),
                       'stock_move': out['spot'] / entry['spot'] - 1})
        i = exit_at + 1
    return trades


def stats(trades: list[dict], days: int) -> dict:
    if not trades:
        return {'trades': 0}
    pnls = [t['pnl'] for t in trades]
    wins = [p for p in pnls if p > 0]
    hits = [t for t in trades if t['how'] == 'target']
    return {'trades': len(trades), 'per_day': round(len(trades) / max(days, 1), 1),
            'win_rate': round(len(wins) / len(pnls), 3), 'per_trade': round(sum(pnls) / len(pnls), 2),
            'total': round(sum(pnls), 2), 'per_day_pnl': round(sum(pnls) / max(days, 1), 2),
            'worst': min(pnls), 'targets': len(hits),
            'flips_small_move': sum(abs(t['stock_move']) < SMALL_MOVE for t in hits),
            'avg_spread': round(sum(t['spread'] for t in trades) / len(trades), 3),
            'avg_minutes': round(sum(t['minutes'] for t in trades) / len(trades), 1)}


def run(store: oq.Store | None = None) -> dict:
    store = store or oq.Store()
    days = store.days()
    split = days[int(len(days) * 2 / 3)] if len(days) >= 3 else None
    results = []
    for ticker in oq.TICKERS:
        loaded = {d: store.day(ticker, d) for d in store.days(ticker)}
        if not loaded:
            continue
        for side in SIDES:
            by_rule = {}
            for target, stop, hold in product(TARGETS, STOPS, HOLDS):
                by_rule[(target, stop, hold)] = {d: scalp_day(s, side == 'call', target, stop, hold) for d, s in loaded.items()}
            early = [d for d in loaded if split and d < split]
            later = [d for d in loaded if not split or d >= split]
            choose_on = early or later  # Too few days to split: the choice is on all of them (said in the report).
            best = max(by_rule, key=lambda k: sum(t['pnl'] for d in choose_on for t in by_rule[k][d]))
            flat = lambda k, ds: [t for d in ds for t in by_rule[k][d]]
            results.append({
                'ticker': ticker, 'side': side, 'rule': {'target': best[0], 'stop': best[1], 'minutes': best[2]},
                'chosen_on': stats(flat(best, choose_on), len(choose_on)),
                'unseen': stats(flat(best, later), len(later)) if early else None,
                'all_rules': sorted(({'target': k[0], 'stop': k[1], 'minutes': k[2], **stats(flat(k, list(loaded)), len(loaded))}
                                     for k in by_rule), key=lambda r: r.get('total', -1e9), reverse=True)[:5]})
    return {'days': days, 'split': split, 'results': results}


def money(x) -> str:
    return f'${x:+,.2f}'


def report(lab: dict) -> str:
    days = lab['days']
    lines = ['---', 'tags:', '  - "trading"', '  - "scalp-sim"', f'updated: "{datetime.now():%Y-%m-%d %H:%M}"', '---',
             '# Scalp Sim', '',
             'Quick value flips on **real recorded option quotes** (Cboe, one snapshot a minute): buy an at-the-money '
             'call or put of the nearest expiry at the ask, sell at the bid when it is up the target, or at the stop or '
             'the time limit, then buy the next one. One contract at a time, $0.03 a contract in fees each way.', '']
    if not days:
        return '\n'.join(lines + ['No quotes recorded yet: the recorder runs on weekdays from 9:30am.'])
    lines.append(f'{len(days)} recorded day(s): {days[0]} to {days[-1]}.')
    if lab['split']:
        lines.append(f"Each rule was chosen on the days before {lab['split']} and **judged on the days from {lab['split']}**.")
    else:
        lines.append('**Too few days to judge a rule on unseen days yet:** the numbers below are where the rule was '
                     'chosen, so they flatter it. Wait for at least a week of recordings.')
    lines += ['', '| Ticker | Side | Best rule | Where chosen: trades a day / wins / $ a trade / $ a day | Unseen days: '
              'trades a day / wins / $ a trade / $ a day | Flips with the stock nearly still | Avg spread paid |',
              '|---|---|---|---|---|---|---|']
    cell = lambda s: (f"{s['per_day']} / {s['win_rate']:.0%} / {money(s['per_trade'])} / {money(s['per_day_pnl'])}"
                      if s and s.get('trades') else 'no trades')
    for r in lab['results']:
        rule = r['rule']
        s = r['chosen_on']
        flips = f"{s.get('flips_small_move', 0)} of {s.get('targets', 0)} target hits" if s.get('trades') else '-'
        lines.append(f"| {r['ticker']} | {r['side']} | +${rule['target']:.2f} target, -${rule['stop']:.2f} stop, "
                     f"{rule['minutes']} min | {cell(s)} | {cell(r['unseen']) if r['unseen'] is not None else 'not yet'} | "
                     f"{flips} | ${s.get('avg_spread', 0):.3f} |")
    lines += ['', '## What to read into it', '',
              '- A rule earns trust only when the unseen days agree with the days it was chosen on.',
              '- "Flips with the stock nearly still" counts target hits where the stock moved under 0.05%: the value '
              'pops the strategy is after.',
              '- The spread paid is lost on every round trip; small targets have to beat it.',
              '- One snapshot a minute misses pops inside a minute, and the quotes run about 15 minutes behind, so '
              'this is a test of the idea, not of live timing.',
              '', 'Run again: `python localtools/scalp_sim.py`. Recorder: `python localtools/option_quotes.py status`.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    lab = run()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(lab, indent=1, default=str))
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(report(lab), encoding='utf-8')
    for r in lab['results']:
        print(r['ticker'], r['side'], r['rule'], r['chosen_on'], 'unseen:', r['unseen'])
    print(f'Wrote {REPORT}')
