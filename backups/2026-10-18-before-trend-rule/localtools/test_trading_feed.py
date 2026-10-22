import json
import tempfile
import unittest
from pathlib import Path
from trading_feed import PriceFeed, TradeJournal, asset_key, candles, macd, pair_trend, read_chart, rsi, scan_summary


class FeedTests(unittest.TestCase):
    def test_reads_real_feed_frames_and_ignores_others(self):
        feed = PriceFeed()
        # Frames exactly as Pocket Option sent them (watched read-only).
        self.assertEqual(feed.add_frame('[["GBPJPY_otc",1792288207.653,211.345]]'), 1)
        self.assertEqual(feed.add_frame('[["GBPJPY_otc",1792288208.097,211.327]]'), 1)
        self.assertEqual(feed.add_frame('451-["updateStream",{"_placeholder":true,"num":0}]'), 0)
        self.assertEqual(feed.add_frame('[[1792285920,[["EURUSD_otc",180,674]]]]'), 0)
        self.assertEqual(feed.add_frame('{"signals":[]}'), 0)
        self.assertEqual(asset_key('GBP/JPY OTC'), asset_key('GBPJPY_otc'))
        self.assertEqual(feed.last('GBPJPYOTC'), (1792288208.097, 211.327))

    def test_candles_rsi_and_macd(self):
        ticks = [(0, 1.0), (2, 1.5), (4, 0.8), (5, 1.1), (9, 1.3), (10, 1.2)]
        self.assertEqual(candles(ticks, 5), [
            {'t': 0, 'o': 1.0, 'h': 1.5, 'l': 0.8, 'c': 0.8},
            {'t': 5, 'o': 1.1, 'h': 1.3, 'l': 1.1, 'c': 1.3},
            {'t': 10, 'o': 1.2, 'h': 1.2, 'l': 1.2, 'c': 1.2}])
        self.assertIsNone(rsi([1.0] * 10))
        self.assertEqual(rsi([float(i) for i in range(20)]), 100.0)
        self.assertEqual(rsi([float(20 - i) for i in range(20)]), 0.0)
        # Equal ups and downs settle at 50.
        self.assertAlmostEqual(rsi([1.0, 2.0] * 20), 50, delta=5)
        self.assertIsNone(macd([1.0] * 20))
        line, signal, hist, _ = macd([1.0] * 40)
        self.assertEqual((line, signal, hist), (0.0, 0.0, 0.0))
        up = macd([1 + i * 0.01 for i in range(60)])
        self.assertGreater(up[0], 0)

    def test_chart_read_reports_indicators_or_warming_up(self):
        feed = PriceFeed()
        for i in range(60):
            feed.add_frame(json.dumps([['EURUSD_otc', 1000 + i * 5, 1.1 + i * 0.0001 * (1 if i % 3 else -1)]]))
        chart = read_chart(feed, 'EURUSDOTC', 5)
        self.assertEqual(chart['candles'], 60)
        self.assertIsNotNone(chart['rsi14'])
        self.assertIn('macd_state', chart)
        self.assertEqual(len(chart['recent_candles'].split()[0]), 12)
        short = read_chart(feed, 'EURUSDOTC', 60)
        self.assertIn('Warming up', short['note'])
        self.assertIn('No prices', read_chart(feed, 'AUDCADOTC', 5)['note'])


class JournalTests(unittest.TestCase):
    def test_settles_results_from_the_feed_and_reports_setups(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = TradeJournal(Path(directory) / 'journal.sqlite')
            feed = PriceFeed()
            for i in range(40):
                feed.add_frame(json.dumps([['GBPJPY_otc', 100 + i, 211 + i * 0.01]]))  # Rising.
            setup = {'rsi_zone': 'high 50-70', 'macd': 'bullish', 'last3_up': 2}
            journal.record('GBPJPY_otc', 'buy', 2, 10, 105, 211.05, setup)
            journal.record('GBPJPY_otc', 'sell', 2, 10, 106, 211.06, setup)
            journal.record('GBPJPY_otc', 'buy', 2, 60, 110, 211.10, setup)  # Not expired yet.
            self.assertEqual(journal.settle(feed, now=130), 2)
            results = {(t['direction'], t['result']) for t in journal.recent()}
            self.assertEqual(results, {('buy', 'win'), ('sell', 'loss'), ('buy', 'open')})
            record = journal.record_for('buy', setup)
            self.assertEqual(record['buy_in_this_setup'], '1 won of 1')
            self.assertEqual(record['sell_in_this_setup'], '0 won of 1')
            self.assertEqual(record['all'], '1 won of 2')
            self.assertEqual(journal.record_for('buy', {'rsi_zone': 'oversold <30', 'macd': 'bearish'})['buy_in_this_setup'], 'no trades yet')


class ScannerTests(unittest.TestCase):
    def test_reads_history_sent_on_a_pair_switch(self):
        feed = PriceFeed()
        feed.add_frame('[["GBPJPY_otc",1792339760.0,213.70]]')
        # The shape Pocket Option sent when the scanner tab switched pair (watched read-only).
        history = {'asset': 'GBPJPY_otc', 'period': 30, 'history': [[1792339064.071 + i, 213.8 + i * 0.001] for i in range(600)]}
        self.assertEqual(feed.add_frame(json.dumps(history)), 600)
        self.assertEqual(len(feed.ticks['GBPJPYOTC']), 601)  # The newer live tick is kept.
        self.assertEqual(feed.last('GBPJPYOTC'), (1792339760.0, 213.70))
        self.assertEqual(feed.add_frame('{"asset":"X","history":"bad"}'), 0)

    def test_ranks_clear_trends_first_in_one_line(self):
        feed = PriceFeed()
        def series(name, step):
            feed.add_frame(json.dumps({'asset': name, 'history': [[1000 + i, 1 + i * step + (0.0004 if i % 7 == 0 else 0)] for i in range(600)]}))
        series('GBPJPY_otc', 0.0002)    # Rising.
        series('AUDCAD_otc', -0.0002)   # Falling.
        feed.add_frame(json.dumps({'asset': 'EURGBP_otc', 'history': [[1000 + i, 1 + (0.001 if i % 2 else 0)] for i in range(600)]}))  # Flat.
        readings = {}
        for name, key in (('GBP/JPY OTC', 'GBPJPYOTC'), ('AUD/CAD OTC', 'AUDCADOTC'), ('EUR/GBP OTC', 'EURGBPOTC')):
            chart = read_chart(feed, key, 15)
            readings[name] = {**chart, **pair_trend(chart)}
        self.assertEqual(readings['GBP/JPY OTC']['direction'], 'up')
        self.assertEqual(readings['AUD/CAD OTC']['direction'], 'down')
        self.assertEqual(readings['EUR/GBP OTC']['direction'], 'no clear trend')
        line = scan_summary(readings, 20, 15)
        self.assertTrue(line.startswith('Pair scanner (live prices, 15s candles, updated 20s ago): clearest trends: '))
        self.assertIn('GBP/JPY OTC up (RSI', line)
        self.assertIn('AUD/CAD OTC down (RSI', line)
        self.assertIn('No clear trend: EUR/GBP OTC', line)
        self.assertIn('no pair shows a clear trend', scan_summary({'EUR/GBP OTC': readings['EUR/GBP OTC']}, 5, 15))


if __name__ == '__main__':
    unittest.main()
