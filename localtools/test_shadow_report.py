import math
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from shadow_report import outcome, replay, report, tip_signal
from trading_feed import PriceFeed, macd_histogram


def v_shape(n=200, turn=120):
    """A fall that speeds up, then slows and turns up (as real moves fade): the
    MACD histogram shrinks towards zero before it crosses."""
    return [100 - 5 * math.tanh((i - turn) / 20) + 0.02 * math.sin(i * 1.7) for i in range(n)][:turn + 40] +         [100 - 5 * math.tanh(40 / 20) + 0.05 * k for k in range(1, n - turn - 39)]


class ShadowTests(unittest.TestCase):
    def test_tip_comes_before_the_cross(self):
        closes = v_shape()
        hist = macd_histogram(closes)
        offset = len(closes) - len(hist)
        # The turn: the histogram crossing up after a run below zero.
        cross = next(i for i in range(6, len(hist)) if hist[i - 1] < 0 <= hist[i] and all(v < 0 for v in hist[i - 6:i]))
        before = [i for i in range(cross + offset - 6, cross + offset) if tip_signal(closes[:i + 1])]
        self.assertTrue(before, 'no tip in the 6 candles before the cross')
        self.assertEqual(tip_signal(closes[:before[0] + 1])['direction'], 'up')

    def test_outcome_needs_prices_through_the_expiry(self):
        ticks = [(t, 1.0 + 0.001 * t) for t in range(0, 30)]
        self.assertEqual(outcome(ticks, 10, 10, ticks[10][1], True, 8), 'win')
        self.assertEqual(outcome(ticks, 10, 10, ticks[10][1], False, 8), 'loss')
        gappy = ticks[:12] + [(t, 2.0) for t in range(20, 30)]
        self.assertIsNone(outcome(gappy, 10, 10, ticks[10][1], True, 8))
        self.assertIsNone(outcome(ticks, 25, 25, ticks[25][1], True, 11))  # Recording ends first.

    def test_recorded_ticks_replay_into_a_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ticks.sqlite'
            feed = PriceFeed(record=path)
            import time
            base = time.time() + 7200
            prices = v_shape(400, 250)
            frame = '[' + ','.join(f'["EURUSD_otc", {base + i}, {p}]' for i, p in enumerate(prices)) + ']'
            feed.add_frame(frame)
            feed.recorder.flush()
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM ticks').fetchone()[0], 400)
            found = replay([(base + i, p) for i, p in enumerate(prices)])
            self.assertTrue(any(f['kind'].startswith('tip') and f['up'] for f in found))
            text = report(48, (8, 11), path)
            self.assertIn('1 OTC pairs', text)
            self.assertIn('tip', text)


if __name__ == '__main__':
    unittest.main()
