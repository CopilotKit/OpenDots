import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

import weekly_puts as W


def put(expiry, strike, bid, ask, delta):
    return {'expiry': expiry, 'call': False, 'strike': strike, 'bid': bid, 'ask': ask, 'delta': delta}


def chain(day, price, quotes):
    """quotes: {(expiry, strike): (bid, ask, delta)}."""
    return {'asof': datetime(day.year, day.month, day.day, 16, 15), 'price': price,
            'options': [put(e, k, *q) for (e, k), q in quotes.items()]}


def closes(last_day, last, n=210, base=600.0):
    days = [last_day - timedelta(days=n - k) for k in range(n)]
    out = {d.isoformat(): base for d in days}
    out[last_day.isoformat()] = last
    return out


class WeeklyPuts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.record = W.Record(Path(self.dir.name) / 'r.sqlite')
        self.day = date(2026, 10, 23)
        self.expiry = date(2026, 10, 30)
        self.quotes = {(self.expiry, 640.0): (2.0, 2.1, -0.31), (self.expiry, 635.0): (1.0, 1.1, -0.22),
                       (self.expiry, 630.0): (0.5, 0.6, -0.15), (date(2026, 11, 6), 640.0): (3.0, 3.2, -0.3)}

    def tearDown(self):
        self.dir.cleanup()

    def test_opens_the_7_day_30_delta_5_wide_spread_in_an_uptrend(self):
        step = W.evening(chain(self.day, 650, self.quotes), closes(self.day, 650), self.record)
        self.assertEqual((step['entry']['short'], step['entry']['long'], step['entry']['expiry']), (640.0, 635.0, '2026-10-30'))
        self.assertAlmostEqual(self.record.open()['credit'], 1.0 - W.SLIP)

    def test_no_entry_below_the_200_day_average(self):
        step = W.evening(chain(self.day, 590, self.quotes), closes(self.day, 590), self.record)
        self.assertIn('not above', step['entry'])
        self.assertIsNone(self.record.open())

    def test_takes_half_then_waits_a_day(self):
        W.evening(chain(self.day, 650, self.quotes), closes(self.day, 650), self.record)
        later = date(2026, 10, 26)
        cheap = {**self.quotes, (self.expiry, 640.0): (0.6, 0.7, -0.15), (self.expiry, 635.0): (0.2, 0.3, -0.08)}
        step = W.evening(chain(later, 660, cheap), closes(later, 660), self.record)
        self.assertEqual(step['closed']['how'], 'took 50%')
        self.assertAlmostEqual(step['closed']['pnl'], (0.98 - 0.42) * 100 - 4 * W.FEE)
        self.assertIn('waits a day', step['entry'])

    def test_held_to_expiry_settles_at_the_expiry_close(self):
        W.evening(chain(self.day, 650, self.quotes), closes(self.day, 650), self.record)
        prices = closes(self.expiry, 637.0)
        step = W.evening(chain(self.expiry, 637.0, {}), prices, self.record)
        self.assertEqual(step['closed']['how'], 'held to expiry')
        self.assertAlmostEqual(step['closed']['pnl'], (0.98 - 3.0) * 100 - 2 * W.FEE)

    def test_one_at_a_time(self):
        W.evening(chain(self.day, 650, self.quotes), closes(self.day, 650), self.record)
        W.evening(chain(date(2026, 10, 26), 650, self.quotes), closes(date(2026, 10, 26), 650), self.record)
        self.assertEqual(len(self.record.rows()), 1)


if __name__ == '__main__':
    unittest.main()
