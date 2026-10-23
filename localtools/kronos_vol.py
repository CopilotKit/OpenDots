"""Does Kronos forecast volatility better than what we have?

Kronos (github.com/shiyu-coder/Kronos, MIT) is a foundation model trained on
price candles. Fed the last 400 hourly SPY/QQQ candles, it draws many possible
paths for the next days; how widely they move is a volatility forecast. Our
options edges are about volatility (how much the stock will move vs what the
options price in), so a better forecast would sharpen them.

The test, on days none of the forecasts were fitted on:
- Kronos: the average squared hourly move across 30 sampled paths, 5 trading days ahead;
- Kronos, corrected: the same, scaled by its average miss on earlier days only;
- HAR (Corsi): daily, weekly and monthly realized variance, refitted on past days;
- Naive: the last month's realized volatility.
Each is scored against what then happened (the same hourly close-to-close measure)
by its average error and QLIKE (the standard loss for variance forecasts; lower is
better), and by how well it ranks calm weeks from wild ones (correlation).

Two steps, so OpenDots' Python and Kronos' (PyTorch) never mix:
  localtools/.venv:  python kronos_vol.py export
  kronos/.venv:      python kronos_vol.py run [--model base|small] [--every 3]
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BARS = ROOT / 'data' / 'kronos-bars.json'
OUT = ROOT / 'data' / 'kronos-vol.json'
KRONOS = ROOT.parent / 'kronos'
VAULT = Path('C:/Users/inter/Desktop/MainAINotes/Site Maps/Robinhood/Kronos Volatility Test.md')
CONTEXT, HORIZON_DAYS, PATHS = 400, 5, 30


# Step 1 (OpenDots' Python): the hourly candles --------------------------------------
def export() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import strategy_lab as sl
    out = {}
    for ticker in ('SPY', 'QQQ'):
        days = sl.edge_lab.sessions(sl.download(ticker, '1h'))
        out[ticker] = {day: [[b['t'].isoformat(), b['o'], b['h'], b['l'], b['c'], b['v']] for b in bars]
                       for day, bars in days.items() if len(bars) >= 6}
    BARS.write_text(json.dumps(out))
    print({t: len(v) for t, v in out.items()}, 'days written to', BARS)


# Step 2 (Kronos' Python): forecasts and scores ----------------------------------------
def realized(closes: np.ndarray) -> float:
    """Sum of squared hourly close-to-close log returns."""
    return float(np.sum(np.diff(np.log(closes)) ** 2))


def har_forecasts(daily_rv: list[float], horizon: int) -> list[float | None]:
    """Walk-forward HAR: for each day k, the forecast of the average daily variance over the
    next `horizon` days, fitted only on days whose outcome was known by day k."""
    rv = np.array(daily_rv)
    rows = []
    for k in range(22, len(rv)):
        x = [1.0, rv[k], rv[k - 4:k + 1].mean(), rv[k - 21:k + 1].mean()]
        y = rv[k + 1:k + 1 + horizon].mean() if k + horizon < len(rv) else None
        rows.append((k, x, y))
    out: list[float | None] = [None] * len(rv)
    coef = None
    for i, (k, x, _) in enumerate(rows):
        if i % 20 == 0:
            known = [(a, b) for kk, a, b in rows[:max(i - horizon, 0)] if b is not None]
            if len(known) >= 60:
                coef = np.linalg.lstsq(np.array([a for a, _ in known]), np.array([b for _, b in known]), rcond=None)[0]
        if coef is not None:
            out[k] = max(float(np.dot(coef, x)), 1e-8)
    return out


def run(model_size: str = 'base', every: int = 3, start: str = '2025-06-01') -> dict:
    import pandas as pd
    import torch
    sys.path.insert(0, str(KRONOS))
    from model import Kronos, KronosPredictor, KronosTokenizer

    torch.manual_seed(7)
    tokenizer = KronosTokenizer.from_pretrained(f'NeoQuasar/Kronos-Tokenizer-{"2k" if model_size == "mini" else "base"}')
    model = Kronos.from_pretrained(f'NeoQuasar/Kronos-{model_size}')
    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=512)
    data = json.loads(BARS.read_text())
    results = {}
    started = time.time()
    for ticker, by_day in data.items():
        days = sorted(by_day)
        bars = [b for d in days for b in by_day[d]]
        ends = {}  # Day -> index just past its last bar.
        n = 0
        for d in days:
            n += len(by_day[d])
            ends[d] = n
        closes = np.array([b[4] for b in bars])
        # Each day's realized variance, close-to-close from the previous day's close.
        daily = []
        for k, d in enumerate(days):
            lo = ends[days[k - 1]] - 1 if k else 0
            daily.append(realized(closes[lo:ends[d]]))
        har = har_forecasts(daily, HORIZON_DAYS)
        rows = []
        for k, d in enumerate(days):
            if d < start or k % every or k + HORIZON_DAYS >= len(days) or ends[d] < CONTEXT or k < 22:
                continue
            past = bars[ends[d] - CONTEXT:ends[d]]
            future = bars[ends[d]:ends[days[k + HORIZON_DAYS]]]
            frame = pd.DataFrame([b[1:6] for b in past], columns=['open', 'high', 'low', 'close', 'volume'])
            x_time = pd.Series(pd.to_datetime([b[0] for b in past]))
            y_time = pd.Series(pd.to_datetime([b[0] for b in future]))
            preds = predictor.predict_batch([frame] * PATHS, [x_time] * PATHS, [y_time] * PATHS, pred_len=len(future),
                                            T=1.0, top_p=0.9, sample_count=1, verbose=False)
            last = past[-1][4]
            path_rv = [realized(np.concatenate([[last], p['close'].to_numpy()])) for p in preds]
            actual = realized(np.array([last] + [b[4] for b in future]))
            naive = float(np.mean(daily[k - 21:k + 1])) * HORIZON_DAYS
            rows.append({'day': d, 'kronos': float(np.mean(path_rv)), 'actual': actual, 'naive': naive,
                         'har': None if har[k] is None else har[k] * HORIZON_DAYS,
                         'kronos_direction': float(np.mean([p['close'].iloc[-1] for p in preds]) / last - 1),
                         'actual_direction': future[-1][4] / last - 1})
            if len(rows) % 10 == 0:
                print(f'{ticker}: {len(rows)} forecasts ({time.time() - started:.0f}s)', flush=True)
        results[ticker] = rows
    summary = score(results)
    OUT.write_text(json.dumps({'model': model_size, 'paths': PATHS, 'horizon_days': HORIZON_DAYS, 'context': CONTEXT,
                               'every': every, 'start': start, 'seconds': round(time.time() - started),
                               'summary': summary, 'rows': results}, indent=1))
    VAULT.write_text(report(summary, model_size), encoding='utf-8')
    return summary


def score(results: dict) -> dict:
    """Errors on annualized volatility, QLIKE on variance, rank correlation; Kronos also
    corrected by its average miss on earlier forecasts only."""
    out = {}
    for ticker, rows in results.items():
        rows = [r for r in rows if r['har'] is not None]
        for k, r in enumerate(rows):  # Correction learned only from earlier forecasts.
            past = rows[max(0, k - 60):k]
            ratio = np.median([p['actual'] / p['kronos'] for p in past]) if len(past) >= 10 else 1.0
            r['kronos_corrected'] = r['kronos'] * ratio
        rows = rows[10:]
        if len(rows) < 3:
            out[ticker] = {'forecasts': len(rows)}
            continue
        vol = lambda v: math.sqrt(v / HORIZON_DAYS * 252)  # Variance over the horizon -> annualized volatility.
        actual = np.array([vol(r['actual']) for r in rows])
        entry = {'forecasts': len(rows)}
        for name in ('kronos', 'kronos_corrected', 'har', 'naive'):
            f = np.array([vol(r[name]) for r in rows])
            var_f, var_a = f ** 2, actual ** 2
            entry[name] = {'error': round(float(np.mean(np.abs(f - actual))), 4),
                           'qlike': round(float(np.mean(var_a / var_f - np.log(var_a / var_f) - 1)), 4),
                           'correlation': round(float(np.corrcoef(f, actual)[0, 1]), 3),
                           'average': round(float(f.mean()), 4)}
        entry['actual_average'] = round(float(actual.mean()), 4)
        hits = [(r['kronos_direction'] > 0) == (r['actual_direction'] > 0) for r in rows]
        entry['direction_hit_rate'] = round(float(np.mean(hits)), 3) if hits else None
        out[ticker] = entry
    return out


def report(summary: dict, model_size: str) -> str:
    names = {'kronos': 'Kronos', 'kronos_corrected': 'Kronos, corrected for its average miss',
             'har': 'HAR (our current forecast)', 'naive': 'Last month\'s volatility'}
    lines = ['---', 'tags:', '  - "trading"', '  - "kronos"', f'updated: "{time.strftime("%Y-%m-%d %H:%M")}"', '---',
             '# Kronos Volatility Test', '',
             f'Kronos-{model_size} (github.com/shiyu-coder/Kronos, MIT) read the last {CONTEXT} hourly candles and drew '
             f'{PATHS} possible paths for the next {HORIZON_DAYS} trading days; the spread of those paths is its '
             'volatility forecast. Scored on what SPY/QQQ then did, against our HAR forecast and last month\'s '
             'volatility, on the same days. Nothing was fitted on the days it was judged on.', '']
    for ticker, s in summary.items():
        if 'kronos' not in s:
            lines += [f'## {ticker}', '', f'Only {s["forecasts"]} forecasts: too few to score.', '']
            continue
        lines += [f'## {ticker} ({s["forecasts"]} forecasts; actual volatility averaged {s["actual_average"]:.1%})', '',
                  '| Forecast | Average error | QLIKE (lower is better) | Ranks calm vs wild (correlation) | Average forecast |',
                  '|---|---|---|---|---|',
                  *[f'| {names[n]} | {s[n]["error"]:.1%} | {s[n]["qlike"]:.3f} | {s[n]["correlation"]:.2f} | {s[n]["average"]:.1%} |'
                    for n in names], '',
                  f'Direction (does the average path end up or down correctly): {s["direction_hit_rate"]:.0%} right.', '']
    lines += ['## Read with care', '',
              '- Hourly candles only; one horizon (5 days). Volatility, not option prices.',
              '- A forecast helps the options edges only if it beats HAR clearly on both tickers.',
              '', 'Rerun: `localtools\\.venv\\Scripts\\python.exe localtools\\kronos_vol.py export`, then '
              '`..\\kronos\\.venv\\Scripts\\python.exe localtools\\kronos_vol.py run`.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['export']:
        export()
    else:
        size = args[args.index('--model') + 1] if '--model' in args else 'base'
        every = int(args[args.index('--every') + 1]) if '--every' in args else 3
        print(json.dumps(run(size, every), indent=1))
