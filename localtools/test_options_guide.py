import math
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

import options_guide as og

ASOF = '2026-10-21 15:00:00'  # UTC: 11:00 in New York.
TODAY = date(2026, 10, 21)


def chain(price=500.0, vol=0.30, bids=True):
    """A made-up SPY chain priced by Black-Scholes at `vol`, a cent wide."""
    rows = []
    et = og.eastern(datetime.strptime(ASOF, '%Y-%m-%d %H:%M:%S'))
    for days in (0, 3, 20):
        expiry = TODAY + timedelta(days=days)
        years = og.years_to(expiry, et)
        for strike in range(470, 531):
            for call in (True, False):
                value = float(og.bs_price(price, strike, years, vol, call))
                d1 = (math.log(price / strike) + 0.5 * vol * vol * years) / (vol * math.sqrt(years))
                delta = og.ncdf(d1) if call else og.ncdf(d1) - 1
                symbol = f'SPY{expiry:%y%m%d}{"C" if call else "P"}{strike * 1000:08d}'
                bid = max(round(value - 0.01, 2), 0) if bids else 0
                rows.append({'option': symbol, 'bid': bid, 'ask': round(value + 0.01, 2) or 0.01, 'iv': vol,
                             'delta': delta, 'theta': -0.05, 'open_interest': 100, 'volume': 10})
    return {'timestamp': ASOF, 'data': {'current_price': price, 'iv30': vol * 100, 'options': rows}}


def getter_for(doc, realized=0.12):
    rng = np.random.RandomState(1)
    daily = list(500 * np.exp(np.cumsum(rng.normal(0, realized / math.sqrt(252), 60))))
    minutes = list(500 * np.exp(np.cumsum(rng.normal(0, realized / math.sqrt(252 * 390), 90))))
    docs = {'options/SPY.json': doc,
            'charts/intraday/SPY.json': {'data': [{'price': {'close': p}} for p in minutes]},
            'charts/historical/SPY.json': {'data': [{'date': f'2026-09-{i % 28 + 1:02d}', 'close': p} for i, p in enumerate(daily)]}}
    return lambda path, max_age=60: docs[path]


class OptionsGuideTests(unittest.TestCase):
    def test_new_york_time_both_sides_of_daylight_saving(self):
        self.assertEqual(og.eastern(datetime(2026, 10, 21, 14, 21)), datetime(2026, 10, 21, 10, 21))
        self.assertEqual(og.eastern(datetime(2026, 12, 1, 15, 0)), datetime(2026, 12, 1, 10, 0))
        self.assertEqual(og.eastern(datetime(2026, 3, 8, 6, 30)), datetime(2026, 3, 8, 1, 30))  # Before 2am EST.
        self.assertEqual(og.eastern(datetime(2026, 3, 8, 7, 30)), datetime(2026, 3, 8, 3, 30))  # After: EDT.
        self.assertFalse(og.market_open(datetime(2026, 10, 24, 11, 0)))  # Saturday.
        self.assertTrue(og.market_open(datetime(2026, 10, 21, 11, 0)))

    def test_chain_symbols_are_read(self):
        parsed = og.parse_chain(chain())
        first = parsed['options'][0]
        self.assertEqual((first['expiry'], first['strike'], first['call']), (TODAY, 470.0, True))
        self.assertEqual(parsed['asof'], datetime(2026, 10, 21, 11, 0))

    def test_credit_spreads_stay_in_the_rules_and_need_an_edge(self):
        m = og.market('SPY', getter_for(chain(vol=0.30), realized=0.12))
        found = og.credit_spreads(m, top=50)
        self.assertTrue(found)
        for c in found:
            self.assertLessEqual(c['max_loss'], og.MAX_LOSS)
            self.assertLessEqual(c['days'], og.MAX_DAYS)
            self.assertGreater(c['ev'], 0)
            self.assertTrue(og.SHORT_DELTA[0] <= abs(c['short_delta']) <= og.SHORT_DELTA[1])
            self.assertEqual(abs(c['legs'][0]['strike'] - c['legs'][1]['strike']), 1)
        self.assertEqual({c['kind'] for c in found}, {'decay spread', 'day credit spread'})
        # Implied volatility below what is expected to happen: no edge, nothing to sell.
        self.assertEqual(og.credit_spreads(og.market('SPY', getter_for(chain(vol=0.08), realized=0.30)), top=50), [])

    def test_lottos_need_a_bid_and_stay_cheap(self):
        m = og.market('SPY', getter_for(chain(vol=0.30)))
        for c in og.lottos(m, top=50):
            self.assertLessEqual(c['max_loss'], og.MAX_DEBIT)
            self.assertEqual(c['qty'], og.LOTTO_QTY)
            self.assertTrue(og.LOTTO_ASK[0] <= -c['price'] <= og.LOTTO_ASK[1])
        self.assertEqual(og.lottos(og.market('SPY', getter_for(chain(vol=0.30, bids=False))), top=50), [])

    def test_rules_gate_suggestions(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = og.Journal(Path(directory) / 'j.sqlite')
            getter = getter_for(chain(vol=0.30))
            open_et = datetime(2026, 10, 21, 11, 0)
            closed = og.suggest(journal, 'SPY', 'credit', getter, datetime(2026, 10, 21, 17, 0))
            self.assertIn('market is closed', closed['note'])
            with self.assertRaisesRegex(ValueError, 'Only SPY, QQQ, TSLA'):
                og.suggest(journal, 'AAPL', 'credit', getter, open_et)
            result = og.suggest(journal, 'SPY', 'credit', getter, open_et)
            self.assertTrue(result['suggestions'])
            self.assertIn('Max loss $', result['say_to_owner'])
            # Asking again logs nothing new: the same trades keep their ids.
            again = og.suggest(journal, 'SPY', 'credit', getter, open_et)
            self.assertEqual([c['id'] for c in again['suggestions']], [c['id'] for c in result['suggestions']])
            self.assertEqual(len(journal._rows()), len({c['id'] for c in result['suggestions']}))
            first = result['suggestions'][0]
            # One trade at a time.
            journal.record(first['id'], 'taken', 0.20)
            self.assertIn('One trade at a time', og.suggest(journal, 'SPY', 'credit', getter, open_et)['note'])
            # Closed for a $70 loss: over the $60 daily limit.
            closed_trade = journal.record(first['id'], 'closed', 0.90)
            self.assertAlmostEqual(closed_trade['pnl'], -70.12, places=2)
            self.assertGreaterEqual(journal.loss_today(og.now_eastern()), og.DAILY_LOSS_LIMIT)
            if og.now_eastern().weekday() < 5:  # On a weekend the market-closed note comes first.
                self.assertIn('Daily loss limit', og.suggest(journal, 'SPY', 'credit', getter, now_today())['note'])

    def test_journal_pnl_and_shadow_results(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = og.Journal(Path(directory) / 'j.sqlite')
            credit = {'kind': 'decay spread', 'ticker': 'SPY', 'expiry': '2026-10-21', 'qty': 1, 'price': 0.20,
                      'legs': [{'action': 'sell', 'type': 'put', 'strike': 495}, {'action': 'buy', 'type': 'put', 'strike': 494}]}
            debit = {'kind': 'debit spread', 'ticker': 'SPY', 'expiry': '2026-10-21', 'qty': 1, 'price': -0.40,
                     'legs': [{'action': 'buy', 'type': 'call', 'strike': 500}, {'action': 'sell', 'type': 'call', 'strike': 501}]}
            lotto = {'kind': 'lotto', 'ticker': 'SPY', 'expiry': '2026-10-21', 'qty': 10, 'price': -0.02,
                     'legs': [{'action': 'buy', 'type': 'call', 'strike': 510}]}
            ids = [journal.add(c) for c in (credit, debit, lotto)]
            # The debit spread taken at 0.40 and sold at 0.70: +$30 less fees.
            journal.record(ids[1], 'taken', 0.40)
            self.assertAlmostEqual(journal.record(ids[1], 'closed', 0.70)['pnl'], 29.88, places=2)
            self.assertEqual(journal.settle({'SPY': {'2026-10-21': 502.0}}), 3)
            shadow = {r['kind']: r['shadow_pnl'] for r in journal._rows()}
            self.assertAlmostEqual(shadow['decay spread'], 19.88, places=2)  # Expired worthless: credit kept.
            self.assertAlmostEqual(shadow['debit spread'], 59.88, places=2)  # Full width $1 less the $0.40 paid.
            self.assertAlmostEqual(shadow['lotto'], -20.6, places=2)  # Expired out of the money.
            summary = journal.summary()
            self.assertEqual(summary['debit spread']['real_pnl'], 29.88)

    def test_managed_results_score_the_80_percent_target(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = og.Journal(Path(directory) / 'j.sqlite')
            day = datetime(2026, 10, 21)
            spread = lambda short, long: {'kind': 'decay spread', 'ticker': 'SPY', 'expiry': '2026-10-21', 'days': 0,
                                          'qty': 1, 'price': 0.20, 'legs': [
                                              {'action': 'sell', 'type': 'put', 'strike': short, 'iv': 0.25},
                                              {'action': 'buy', 'type': 'put', 'strike': long, 'iv': 0.25}]}
            far, near = journal.add(spread(490, 489)), journal.add(spread(499, 498))
            # Logged at 10:00 New York (14:00 UTC); SPY slides from 501 to 497 by the close.
            with og.closing(og.sqlite3.connect(journal.path)) as db, db:
                db.execute('UPDATE suggestions SET ts=?', (datetime(2026, 10, 21, 14, 0, tzinfo=og.timezone.utc).timestamp(),))
            journal.save_bars('SPY', [{'time': day.replace(hour=10) + timedelta(minutes=i), 'price': 501 - i * 4 / 360}
                                      for i in range(0, 360)])
            self.assertEqual(journal.settle_managed(datetime(2026, 10, 21, 16, 30)), 2)
            rows = {r['id']: r for r in journal._rows()}
            self.assertEqual(rows[far]['managed_how'], 'profit target')  # Far from the move: credit kept.
            self.assertGreater(rows[far]['managed_pnl'], 0)
            self.assertEqual(rows[near]['managed_how'], 'stop')  # The slide ran through it: stopped out.
            self.assertLess(rows[near]['managed_pnl'], 0)
            score = journal.summary()['decay spread']
            self.assertEqual((score['scored'], score['win_rate']), (2, 0.5))
            self.assertIn('not yet', score['target'])
            # Still running, or prices missing for the day: left unscored.
            journal.add({**spread(480, 479), 'expiry': '2026-10-23'})
            self.assertEqual(journal.settle_managed(datetime(2026, 10, 21, 16, 30)), 0)


class TrackTests(unittest.TestCase):
    def test_a_credit_spread_replays_from_its_price_to_its_target(self):
        data = {'kind': 'decay spread', 'ticker': 'SPY', 'expiry': '2026-10-21', 'days': 0, 'qty': 1, 'price': 0.20,
                'legs': [{'action': 'sell', 'type': 'put', 'strike': 495, 'iv': 0.25},
                         {'action': 'buy', 'type': 'put', 'strike': 494, 'iv': 0.25}]}
        start = datetime(2026, 10, 21, 11, 0)
        # SPY drifts up away from the put spread through the afternoon.
        bars = [{'time': start + timedelta(minutes=i), 'price': 497 + i * 0.01} for i in range(0, 300)]
        result = og.track(data, start, bars)
        self.assertAlmostEqual(result['points'][0]['pnl'], -4 * og.FEE * 100 / 100, places=2)  # Only fees at entry.
        self.assertGreater(result['now_pnl'], 10)  # Most of the $20 credit kept.
        self.assertEqual(result['managed_exit']['event'], 'profit target')
        # A drop through the short strike: the stop comes first.
        crash = [{'time': start + timedelta(minutes=i), 'price': 497 - i * 0.05} for i in range(0, 120)]
        self.assertEqual(og.track(data, start, crash)['managed_exit']['event'], 'stop')


class SignalTests(unittest.TestCase):
    def test_vwap_rejection_becomes_a_limit_priced_debit_spread_with_lab_exits(self):
        m = og.market('SPY', getter_for(chain(price=500.0, vol=0.30)))
        start = datetime(2026, 10, 21, 9, 30)
        closes = [499.0] * 6 + [499.5, 500.5, 501.5, 502.0, 502.5, 502.0, 501.5, 501.0, 500.8, 500.6, 499.8]
        m['bars5'] = [{'t': start + timedelta(minutes=5 * i), 'o': c, 'h': c + 0.2, 'l': c - 0.2, 'c': c, 'v': 1000}
                      for i, c in enumerate(closes)]
        m['history5'] = [499.0 + 0.01 * i for i in range(120)]
        found = og.signal_spreads(m)
        rejection = [c for c in found if c['kind'] == 'signal: VWAP rejection']
        self.assertEqual(len(rejection), 1, found)
        trade = rejection[0]
        self.assertEqual(trade['legs'][0]['type'], 'put')  # Bearish.
        self.assertEqual(trade['legs'][0]['strike'] - trade['legs'][1]['strike'], 1)
        self.assertEqual(trade['exit'], {'target': 0.5, 'stop': 0.5, 'minutes': 30})
        self.assertLessEqual(trade['max_loss'], og.MAX_DEBIT)
        self.assertEqual(-trade['price'], trade['limit'])
        self.assertIn('never market', trade['manage'])
        # Only the latest bar counts: the same morning one bar later suggests nothing new.
        m['bars5'].append({'t': start + timedelta(minutes=5 * len(closes)), 'o': 499.7, 'h': 499.9, 'l': 499.5, 'c': 499.7, 'v': 1000})
        self.assertFalse([c for c in og.signal_spreads(m) if c['kind'] == 'signal: VWAP rejection'])
        # Its replay closes by its own exits: after 30 minutes at the latest.
        bars = [{'time': datetime(2026, 10, 21, 11, 0) + timedelta(minutes=i), 'price': 499.8} for i in range(60)]
        result = og.track(trade, datetime(2026, 10, 21, 11, 0), bars)
        self.assertEqual(result['managed_exit']['event'], 'time exit')
        self.assertEqual(result['managed_exit']['time'], '11:30')


def now_today():
    """Today's New York time at 11:00, for the daily limit (it counts today's closes)."""
    et = og.now_eastern()
    return et.replace(hour=11, minute=0)


if __name__ == '__main__':
    unittest.main()
