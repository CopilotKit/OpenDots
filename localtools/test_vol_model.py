import math
import unittest
from datetime import datetime, timedelta

import numpy as np

import vol_model as vm


def days_of(n: int, daily_vol: float, seed: int = 3) -> dict:
    rng = np.random.default_rng(seed)
    out, p, day = {}, 500.0, datetime(2025, 1, 6)
    while len(out) < n:
        if day.weekday() < 5:
            rows = []
            for h in range(7):
                o = p
                p *= math.exp(rng.normal(0, daily_vol / math.sqrt(7)))
                rows.append({'t': day.replace(hour=9 + h, minute=30), 'o': o, 'h': max(o, p), 'l': min(o, p), 'c': p})
            out[day.strftime('%Y-%m-%d')] = rows
        day += timedelta(days=1)
    return out


class ForecastTests(unittest.TestCase):
    def test_realized_variance_and_the_forecast_track_how_much_prices_move(self):
        calm, wild = vm.realized(days_of(150, 0.005)), vm.realized(days_of(150, 0.02))
        self.assertLess(np.mean(list(calm.values())), np.mean(list(wild.values())) / 4)
        forecast = vm.har_forecasts(calm, 5)
        self.assertTrue(forecast)
        # Daily moves of 0.5% are ~8% a year: the forecast should land near that.
        self.assertAlmostEqual(float(np.median(list(forecast.values()))), 0.005 * math.sqrt(252), delta=0.03)

    def test_the_forecast_only_uses_the_past(self):
        rv = vm.realized(days_of(150, 0.01))
        before = vm.har_forecasts(rv, 5)
        names = sorted(rv)
        changed = dict(rv)
        for n in names[-10:]:
            changed[n] *= 50  # A later shock must not change earlier forecasts.
        after = vm.har_forecasts(changed, 5)
        early = [n for n in before if n < names[-40]]
        self.assertTrue(early)
        self.assertTrue(all(abs(before[n] - after[n]) < 1e-12 for n in early))


class ScoreTests(unittest.TestCase):
    def test_ridge_learns_a_simple_relation(self):
        rng = np.random.default_rng(1)
        X = rng.normal(size=(400, 3))
        y = 2 * X[:, 0] - X[:, 2] + rng.normal(0, 0.1, 400)
        predict = vm.ridge(X, y, alpha=0.1)
        self.assertAlmostEqual(float(predict([[1.0, 0.0, 0.0]])[0] - predict([[0.0, 0.0, 0.0]])[0]), 2.0, delta=0.1)

    def test_days_are_counted_by_day(self):
        result = vm.by_day([('2026-10-19', 10.0), ('2026-10-19', -4.0), ('2026-10-20', -50.0)],
                           ['2026-10-19', '2026-10-20', '2026-10-21'])
        self.assertEqual((result['traded'], result['profitable_days'], result['total']), (2, 1, -44.0))
        self.assertEqual(result['share_of_all_days_profitable'], round(1 / 3, 3))
        self.assertEqual(result['worst_week'][1], -44.0)


if __name__ == '__main__':
    unittest.main()
