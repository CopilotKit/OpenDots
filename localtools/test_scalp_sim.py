import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

import option_quotes as oq
import scalp_sim as ss

CALL = 'SPY261022C00700000'
PUT = 'SPY261022P00700000'


def snaps(path, start=datetime(2026, 10, 22, 9, 31), spot=700.0):
    """A made-up day: one snapshot a minute of market time, (bid, ask) of the at-the-money call."""
    out = []
    for k, quote in enumerate(path):
        quotes = {PUT: {'expiry': date(2026, 10, 22), 'strike': 700.0, 'call': False, 'bid': 1.0, 'ask': 1.02,
                        'iv': 0.15, 'delta': -0.5}}
        if quote:
            bid, ask = quote
            quotes[CALL] = {'expiry': date(2026, 10, 22), 'strike': 700.0, 'call': True, 'bid': bid, 'ask': ask,
                            'iv': 0.15, 'delta': 0.5}
        out.append({'asof': start + timedelta(minutes=k) + oq.QUOTE_DELAY, 'spot': spot, 'quotes': quotes})
    return out


class ScalpTests(unittest.TestCase):
    def test_a_pop_to_the_target_is_sold_at_the_bid_and_the_next_one_bought(self):
        day = snaps([(0.98, 1.00), (1.05, 1.07), (1.06, 1.08), (1.08, 1.09)])
        trades = ss.scalp_day(day, True, target=0.05, stop=0.10, hold=30)
        self.assertEqual(trades[0]['how'], 'target')
        self.assertEqual(trades[0]['pnl'], round((1.05 - 1.00) * 100 - 2 * ss.FEE, 2))
        self.assertEqual(trades[0]['entered'], '09:31')
        self.assertEqual(trades[1]['paid'], 1.08)  # Bought again at the next snapshot's ask.
        self.assertEqual(trades[0]['spread'], 0.02)
        self.assertEqual(trades[0]['stock_move'], 0.0)  # A value flip with the stock still.

    def test_stop_and_time_limit(self):
        stopped = ss.scalp_day(snaps([(0.98, 1.00), (0.95, 0.97), (0.89, 0.91)]), True, 0.20, 0.10, 30)
        self.assertEqual((stopped[0]['how'], stopped[0]['sold']), ('stop', 0.89))  # The first snapshot past the stop.
        timed = ss.scalp_day(snaps([(0.98, 1.00)] + [(1.01, 1.03)] * 6), True, 0.20, 0.40, 5)
        self.assertEqual((timed[0]['how'], timed[0]['minutes']), ('time', 5))

    def test_a_missing_quote_waits_and_late_entries_are_not_taken(self):
        day = snaps([(0.98, 1.00), None, (1.10, 1.12)])
        self.assertEqual(ss.scalp_day(day, True, 0.05, 0.10, 30)[0]['minutes'], 2)
        late = snaps([(0.98, 1.00), (1.10, 1.12)], start=datetime(2026, 10, 22, 15, 31))
        self.assertEqual(ss.scalp_day(late, True, 0.05, 0.10, 30), [])

    def test_the_lab_chooses_on_early_days_and_judges_on_later_ones(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = oq.Store(Path(directory.name) / 'quotes.sqlite')
        for n in range(3):
            start = datetime(2026, 10, 20 + n, 9, 31)
            for snapshot in snaps([(0.98, 1.00), (1.05, 1.07), (1.10, 1.12)], start=start):
                options = [{'symbol': s, 'expiry': date(2026, 10, 20 + n), **{k: q[k] for k in ('strike', 'call', 'bid', 'ask', 'iv', 'delta')},
                            'oi': 0.0, 'volume': 0.0} for s, q in snapshot['quotes'].items()]
                store.save('SPY', {'price': snapshot['spot'], 'asof': snapshot['asof'], 'options': options})
        lab = ss.run(store)
        self.assertEqual(lab['split'], '2026-10-22')
        spy_call = next(r for r in lab['results'] if r['ticker'] == 'SPY' and r['side'] == 'call')
        self.assertEqual(spy_call['unseen']['trades'] > 0, True)
        self.assertIn('judged on the days from 2026-10-22', ss.report(lab))


if __name__ == '__main__':
    unittest.main()
