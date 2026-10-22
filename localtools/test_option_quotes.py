import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

import option_quotes as oq


def option(strike, call=True, expiry=date(2026, 10, 22), bid=1.0, ask=1.02):
    side = 'C' if call else 'P'
    return {'symbol': f'SPY{expiry:%y%m%d}{side}{int(strike * 1000):08d}', 'expiry': expiry, 'call': call,
            'strike': strike, 'bid': bid, 'ask': ask, 'iv': 0.15, 'delta': 0.5, 'theta': -0.5, 'oi': 10.0, 'volume': 5.0}


def chain(asof=datetime(2026, 10, 22, 10, 0), price=700.0, options=None):
    return {'price': price, 'iv30': 0.15, 'asof': asof, 'options': options if options is not None else [option(700)]}


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = oq.Store(Path(self.directory.name) / 'quotes.sqlite')

    def tearDown(self):
        self.directory.cleanup()

    def test_only_near_the_money_contracts_of_the_nearest_expiries_are_kept(self):
        old, today, next_day, later = (date(2026, 10, 21), date(2026, 10, 22), date(2026, 10, 23), date(2026, 10, 30))
        options = [option(700, expiry=today), option(700, expiry=next_day), option(700, expiry=later),
                   option(700, expiry=old), option(720, expiry=today), option(686, call=False, expiry=today),
                   option(701, expiry=today, bid=0, ask=0), option(702, expiry=today, bid=1.1, ask=1.0)]
        kept = oq.near(chain(options=options))
        self.assertEqual(sorted((o['strike'], o['expiry'], o['call']) for o in kept),
                         [(686, today, False), (700, today, True), (700, next_day, True)])

    def test_a_snapshot_is_saved_once_and_read_back_by_day(self):
        self.assertEqual(self.store.save('SPY', chain()), 1)
        self.assertEqual(self.store.save('SPY', chain()), 0)  # Cboe has not published a new one yet.
        self.store.save('SPY', chain(asof=datetime(2026, 10, 22, 10, 1), options=[option(700, bid=1.1, ask=1.12)]))
        snaps = self.store.day('SPY', '2026-10-22')
        self.assertEqual([s['asof'].minute for s in snaps], [0, 1])
        self.assertEqual(snaps[1]['quotes']['SPY261022C00700000']['bid'], 1.1)
        self.assertEqual(self.store.days(), ['2026-10-22'])
        self.assertEqual(self.store.status()['tickers']['SPY']['snapshots'], 2)

    def test_one_failing_ticker_does_not_stop_the_others(self):
        def getter(path, max_age):
            if 'QQQ' in path:
                raise ConnectionError('feed down')
            return {'timestamp': '2026-10-22 14:00:00', 'data': {'current_price': 700, 'options': [
                {'option': 'SPY261022C00700000', 'bid': 1.0, 'ask': 1.02}]}}

        saved = oq.record_once(self.store, getter, log=lambda *a: None)
        self.assertEqual(saved['SPY'], 1)
        self.assertIn('feed down', saved['QQQ'])
        self.assertEqual(saved['TSLA'], 1)

    def test_it_records_in_the_session_and_stops_after_4_20pm(self):
        clock = [datetime(2026, 10, 22, 9, 29, 40)]  # A Thursday.
        passes = []

        def tick(seconds):
            clock[0] += timedelta(seconds=seconds)

        oq.record_once, original = (lambda store, getter, log: passes.append(clock[0])), oq.record_once
        try:
            oq.run(self.store, clock=lambda: clock[0], sleep=tick)
        finally:
            oq.record_once = original
        self.assertEqual(passes[0], datetime(2026, 10, 22, 9, 30))
        self.assertLess(passes[-1], datetime(2026, 10, 22, 16, 20))
        self.assertGreaterEqual(clock[0], datetime(2026, 10, 22, 16, 20))

    def test_quote_time_is_the_publish_time_less_the_delay(self):
        self.assertEqual(oq.session_time(datetime(2026, 10, 22, 9, 45)), datetime(2026, 10, 22, 9, 30))


if __name__ == '__main__':
    unittest.main()
