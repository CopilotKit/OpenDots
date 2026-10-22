import json
import tempfile
import unittest
from pathlib import Path
from trading_feed import PriceFeed, bars_from_candles, read_bars, reversal_signal, TradeJournal, asset_key, candle_period, candles, macd, pair_trend, read_chart, rsi


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


class StudyTests(unittest.TestCase):
    def test_candle_size_follows_the_expiry(self):
        self.assertEqual({e: candle_period(e) for e in (11, 60, 300, 3600, 14400)},
                         {11: 5, 60: 15, 300: 60, 3600: 900, 14400: 3600})

    def test_summary_and_csv_keep_reasons_by_market_and_expiry(self):
        import csv
        with tempfile.TemporaryDirectory() as directory:
            journal = TradeJournal(Path(directory) / 'journal.sqlite')
            feed = PriceFeed()
            for i in range(200):
                feed.add_frame(json.dumps([['EURUSD_otc', 100 + i, 1.1 + i * 0.001]]))
                feed.add_frame(json.dumps([['EURUSD', 100 + i, 1.1 - i * 0.001]]))
            journal.record('EURUSD_otc', 'buy', 5, 11, 105, 1.105, {'rsi_zone': 'high 50-70', 'macd': 'bullish', 'trend': 'up', 'reason': 'BUY: green candles'})
            journal.record('EURUSD', 'buy', 5, 60, 110, 1.09, {'rsi_zone': 'low 30-50', 'macd': 'bearish', 'trend': 'down', 'reason': 'BUY: news looked good'})
            self.assertEqual(journal.settle(feed, now=400), 2)
            summary = journal.summary()
            self.assertEqual(summary['all'], '1 won of 2 (50%)')
            self.assertEqual(summary['market'], {'OTC': '1 won of 1 (100%)', 'real market': '0 won of 1 (0%)'})
            self.assertEqual(summary['expiry'], {'11s': '1 won of 1 (100%)', '1m': '0 won of 1 (0%)'})
            path = Path(directory) / 'journal.csv'
            self.assertEqual(journal.export_csv(path), 2)
            rows = list(csv.DictReader(open(path, encoding='utf-8')))
            self.assertEqual([(r['market'], r['result'], r['reason']) for r in rows],
                             [('OTC', 'win', 'BUY: green candles'), ('real', 'loss', 'BUY: news looked good')])


class TimeframeCandleTests(unittest.TestCase):
    def test_ready_made_candles_are_stored_by_size_and_extended_by_ticks(self):
        import time as clock
        end = int(clock.time() // 300 * 300)
        rows = [[end - i * 300, 1.0 + i, 1.5 + i, 2.0 + i, 0.5 + i, 40] for i in range(30)]  # Newest first.
        self.assertEqual([b['t'] for b in bars_from_candles(rows)][:2], [end - 29 * 300, end - 28 * 300])
        feed = PriceFeed()
        text = json.dumps({'candles': rows, 'asset': 'EURUSD_otc', 'period': 300, 'history': []})
        self.assertEqual(feed.add_frame(text), 30)
        self.assertEqual(feed.candles_for('EURUSDOTC', 60), [])
        feed.add_frame(json.dumps([['EURUSD_otc', end + 10, 9.0]]))
        feed.add_frame(json.dumps([['EURUSD_otc', end + 310, 0.1]]))
        bars = feed.candles_for('EURUSDOTC', 300)
        self.assertEqual(len(bars), 31)
        self.assertEqual((bars[-2]['h'], bars[-2]['c']), (9.0, 9.0))  # Tick folded into the current candle.
        self.assertEqual((bars[-1]['t'], bars[-1]['o'], bars[-1]['c']), (end + 300, 0.1, 0.1))  # And a new one opened.
        self.assertEqual(feed.candles_for('EURUSDOTC', 300, max_age=-1), [])  # Stale sets are not used.


class FeedClockTests(unittest.TestCase):
    def test_trades_settle_in_the_sites_clock_and_open_trades_are_known(self):
        import time as clock
        ahead = clock.time() + 7200  # The site stamps prices 2 hours ahead of this PC.
        feed = PriceFeed()
        feed.add_frame(json.dumps([['EURUSD_otc', ahead - 20, 1.0]]))
        self.assertAlmostEqual(feed.now(), ahead - 20, delta=1)
        with tempfile.TemporaryDirectory() as directory:
            journal = TradeJournal(Path(directory) / 'j.sqlite')
            journal.record('EURUSD_otc', 'buy', 5, 11, ahead - 20, 1.0, {})
            self.assertEqual(journal.settle(feed), 0)  # Not expired in the site's clock yet.
            self.assertEqual(len(journal.open_trades(feed.now())), 1)
            feed.add_frame(json.dumps([['EURUSD_otc', ahead - 10, 1.1], ['EURUSD_otc', ahead - 8, 1.2]]))
            self.assertEqual(journal.settle(feed), 1)  # Settles without waiting 2 real hours.
            self.assertEqual(journal.open_trades(feed.now()), [])
            self.assertEqual(journal.last_closed()['result'], 'WON')
            self.assertEqual(journal.last_closed()['trade'], 'BUY $5 for 11s')
            # Losses in a row, newest first, counted only after a given moment (a scan).
            for i, exit_price in enumerate((0.9, 0.8, 0.7)):
                journal.record('EURUSD_otc', 'buy', 1, 11, ahead + i * 20, 1.0, {})
                feed.add_frame(json.dumps([['EURUSD_otc', ahead + i * 20 + 11, exit_price], ['EURUSD_otc', ahead + i * 20 + 12, exit_price]]))
                journal.settle(feed)
            self.assertEqual(journal.losing_streak(), 3)
            self.assertEqual(journal.losing_streak(since=ahead + 5), 2)


class ReadyCandleTests(unittest.TestCase):
    def test_one_minute_reading_uses_the_30_second_candles_sent_on_a_switch(self):
        import time as clock
        now = clock.time()
        end = int(now // 30 * 30)
        rows = [[end - i * 30, 1 + (88 - i) * 0.001, 1 + (89 - i) * 0.001, 1 + (89 - i) * 0.001 + 0.0002,
                 1 + (88 - i) * 0.001 - 0.0002, 40] for i in range(89)]  # 44 minutes, rising, newest first.
        history = [[now - 660 + s, 1.08 + s * 0.00001] for s in range(660)]  # 11 minutes of ticks.
        feed = PriceFeed()
        feed.add_frame(json.dumps({'candles': rows, 'asset': 'CADJPY_otc', 'period': 30, 'history': history}))
        chart = read_chart(feed, 'CADJPYOTC', 60)
        self.assertGreaterEqual(chart['candles'], 44)
        self.assertIsNotNone(chart['rsi14'])
        self.assertIn('macd_state', chart)
        self.assertNotIn('note', chart)


class ReversalTests(unittest.TestCase):
    def bars(self, closes):
        return [{'t': i * 5, 'o': c, 'h': c, 'l': c, 'c': c} for i, c in enumerate(closes)]

    def test_macd_turning_down_after_rsi_above_70_is_a_high_confidence_sell(self):
        rise = [1 + i * 0.001 + (0.0003 if i % 5 == 0 else 0) for i in range(60)]  # Strong rise: RSI above 70.
        closes = rise + [rise[-1] - 0.002 * (k + 1) for k in range(3)]  # Then it turns down hard.
        signal = reversal_signal(closes)
        self.assertEqual((signal['direction'], signal['kind']), ('down', 'reversal'))
        self.assertIn('red over green', signal['why'])
        self.assertIn('above 70', signal['why'])
        trend = pair_trend(read_bars(self.bars(closes), 'EUR/USD OTC', 5))
        self.assertEqual((trend['direction'], trend['score'], trend['signal']), ('down', 30, 'reversal'))

    def test_falling_into_rsi_below_30_then_turning_up_is_a_buy_reversal(self):
        fall = [2 - i * 0.001 - (0.0003 if i % 5 == 0 else 0) for i in range(60)]
        closes = fall + [fall[-1] + 0.002 * (k + 1) for k in range(3)]
        self.assertEqual(reversal_signal(closes)['direction'], 'up')
        self.assertEqual(reversal_signal(closes)['kind'], 'reversal')

    def test_macd_cross_rsi_above_70_and_the_band_curving_over_is_a_top_setup(self):
        rise = [1 + i * 0.0008 + (0.0003 if i % 5 == 0 else 0) for i in range(60)]
        closes = rise + [rise[-1] - 0.001 * (k + 1) for k in range(2)]
        bars = [{'t': i * 5, 'o': closes[i - 1] if i else c, 'c': c, 'l': min(c, closes[i - 1] if i else c),
                 'h': max(c, closes[i - 1] if i else c) + 0.002} for i, c in enumerate(closes)]  # Wicks reach the upper band.
        chart = read_bars(bars, 'EUR/USD OTC', 5)
        self.assertIn('curving over', chart['bollinger'])
        self.assertEqual((chart['signal']['direction'], chart['signal']['kind']), ('down', 'top'))
        self.assertIn('red over green', chart['signal']['why'])
        self.assertEqual(pair_trend(chart)['score'], 40)

    def test_chop_gives_no_signal_and_a_stretched_trend_is_not_very_high(self):
        chop = [1 + (0.001 if i % 2 else 0) for i in range(80)]
        self.assertIsNone(reversal_signal(chop))
        steady = [1 + i * 0.001 + (i ** 2) * 1e-5 - (0.0002 if i % 6 == 0 else 0) for i in range(80)]  # Still rising, RSI > 70.
        chart = read_bars(self.bars(steady), 'EUR/USD OTC', 5)
        self.assertGreaterEqual(chart['rsi14'], 70)
        self.assertNotIn('signal', chart)
        trend = pair_trend(chart)
        self.assertEqual(trend['direction'], 'up')
        self.assertLessEqual(trend['score'], 15)  # 'good', not 'very high', when chasing an overbought move.


if __name__ == '__main__':
    unittest.main()
