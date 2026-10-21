import math
import unittest
from datetime import datetime, timedelta

import numpy as np

import options_guide as og
import strategy_lab as sl

FLAT_SKEW = {'level': {0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0},
             'put': (np.array([-5.0, 0.0]), np.array([1.6, 1.0])), 'call': (np.array([0.0, 5.0]), np.array([1.0, 1.0]))}


def days_of(prices_by_day: list[list[float]], index=16.0) -> dict:
    """Made-up sessions: 78 five-minute bars a day from 9:30, weekdays from Mon 2026-08-03."""
    out, day = {}, datetime(2026, 8, 3)
    for prices in prices_by_day:
        while day.weekday() > 4:
            day += timedelta(days=1)
        rows = [{'t': day.replace(hour=9, minute=30) + timedelta(minutes=5 * i), 'o': p, 'h': p + 0.2, 'l': p - 0.2,
                 'c': p, 'v': 1000, 'index': index} for i, p in enumerate(prices)]
        out[day.strftime('%Y-%m-%d')] = rows
        day += timedelta(days=1)
    return out


class PricingTests(unittest.TestCase):
    def test_the_fast_pricing_matches_the_guide(self):
        for x in (-3, -1, 0, 0.5, 2.5):
            self.assertAlmostEqual(float(sl.ncdf(x)), og.ncdf(x), places=6)
        for strike, call in ((95, False), (105, True), (100, True)):
            self.assertAlmostEqual(float(sl.bs(100, strike, 0.02, 0.25, call)), float(og.bs_price(100, strike, 0.02, 0.25, call)), places=4)
        self.assertEqual(float(sl.bs(100, 95, 0.0, 0.2, False)), 0.0)  # Expired out of the money.

    def test_the_skew_makes_far_puts_dearer(self):
        near = sl.leg_vol(FLAT_SKEW, 16, 1, 100, 99.5, 1 / 365, 'put')
        far = sl.leg_vol(FLAT_SKEW, 16, 1, 100, 96, 1 / 365, 'put')
        self.assertGreater(float(far), float(near))
        self.assertAlmostEqual(float(sl.leg_vol(FLAT_SKEW, 16, 1, 100, 100, 1 / 365, 'put')), 0.16, places=3)


class ClockTests(unittest.TestCase):
    def test_only_market_hours_count(self):
        friday_close = datetime(2026, 10, 23, 16, 0)
        # From Friday's close to Monday's close: one trading day, not three calendar days.
        self.assertAlmostEqual(sl.trading_years(friday_close, datetime(2026, 10, 26).date()), 1 / 252)
        self.assertAlmostEqual(sl.trading_years(datetime(2026, 10, 21, 12, 45), datetime(2026, 10, 21).date()),
                               195 / (252 * 390))

    def test_the_stock_price_comes_from_the_option_quotes(self):
        # After hours Cboe's price drifts; the quotes still say 500 (call - put + strike).
        options = []
        for k in (498, 499, 500, 501, 502):
            call, put = max(500 - k, 0) + 1.0, max(k - 500, 0) + 1.0
            options += [{'strike': k, 'call': True, 'bid': call - 0.01, 'ask': call + 0.01, 'expiry': datetime(2026, 10, 23).date()},
                        {'strike': k, 'call': False, 'bid': put - 0.01, 'ask': put + 0.01, 'expiry': datetime(2026, 10, 23).date()}]
        chain = {'price': 496.0, 'asof': datetime(2026, 10, 21, 18, 0), 'options': options}
        by_expiry = {datetime(2026, 10, 23).date(): options}
        self.assertAlmostEqual(sl.implied_spot(chain, by_expiry), 500.0)


class TradeTests(unittest.TestCase):
    def test_a_calm_day_keeps_the_credit_and_a_crash_is_stopped(self):
        calm = days_of([[500.0] * 78])
        names = sorted(calm)
        tr = sl.trade(calm, names, 0, (10, 30), 0, 0.15, 'put', FLAT_SKEW)
        self.assertLess(tr['short'], 500)
        self.assertGreater(tr['credit'], 0.03)
        held = sl.exit_pnl(tr, None, None, False)
        # Out at 3:45pm (the rule): most of the credit kept, a little left in the spread.
        self.assertGreater(held, 0.5 * (tr['credit'] * 100 - 4 * sl.FEE))
        self.assertLess(held, tr['credit'] * 100 - 4 * sl.FEE)
        self.assertGreater(sl.exit_pnl(tr, 0.5, 2.0, False), 0)
        crash = days_of([[500.0] * 12 + [500 - i * 0.2 for i in range(66)]])
        tr = sl.trade(crash, sorted(crash), 0, (10, 30), 0, 0.15, 'put', FLAT_SKEW)
        stopped, held = sl.exit_pnl(tr, None, 2.0, False), sl.exit_pnl(tr, None, None, False)
        self.assertLess(held, -50)  # Through both strikes: near the full $1 loss.
        self.assertGreater(stopped, held)  # The stop cut it.

    def test_rules_pick_sides(self):
        self.assertEqual(sl.sides_for('both', 'flat'), ('put', 'call'))
        self.assertEqual(sl.sides_for('trend', 'up'), ('put',))
        self.assertEqual(sl.sides_for('fade', 'up'), ('call',))
        self.assertEqual(sl.sides_for('trend', 'flat'), ())


class LabTests(unittest.TestCase):
    def test_the_lab_chooses_on_early_days_and_judges_on_later_ones(self):
        rng = np.random.default_rng(7)
        prices, p = [], 500.0
        for _ in range(24):
            day = list(p + np.cumsum(rng.normal(0, 0.15, 78)))
            prices.append(day)
            p = day[-1]
        history = {'SPY': days_of(prices), 'QQQ': days_of(prices)}
        real = sl.TIMES, sl.DTES, sl.DELTAS
        sl.TIMES, sl.DTES, sl.DELTAS = ((10, 30),), (0,), (0.15,)
        try:
            lab = sl.run(history, {'SPY': FLAT_SKEW, 'QQQ': FLAT_SKEW}, log=lambda *a: None)
        finally:
            sl.TIMES, sl.DTES, sl.DELTAS = real
        self.assertGreater(lab['passed_train'], 0)
        for r in lab['top']:
            self.assertGreaterEqual(r['train']['win_rate'], og.MIN_POP)
            self.assertGreater(r['train']['per_trade'], 0)
            self.assertGreater(r['test']['n'], 0)
        self.assertIn('Strategy Lab', sl.report(lab))
        self.assertTrue(sl.describe(lab['top'][0]))


if __name__ == '__main__':
    unittest.main()
