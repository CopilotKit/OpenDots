import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import options_guide as og
import options_watch as ow

DAY = datetime(2026, 10, 21)
SPREAD = {'kind': 'debit spread', 'ticker': 'SPY', 'expiry': '2026-10-23', 'days': 2, 'qty': 1, 'price': -0.45,
          'legs': [{'action': 'buy', 'type': 'call', 'strike': 500, 'iv': 0.2},
                   {'action': 'sell', 'type': 'call', 'strike': 501, 'iv': 0.2}]}


def bars(path):
    return [{'time': DAY.replace(hour=10) + timedelta(minutes=i), 'price': p} for i, p in enumerate(path)]


# Up 60 cents in the first hour, then down 90 cents: a winner that turns into a loser.
RISE_AND_FALL = [500 + 0.6 * min(i, 60) / 60 - 0.9 * max(i - 60, 0) / 60 for i in range(150)]


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = og.Journal(Path(self.directory.name) / 'j.sqlite')
        self.trade = self.journal.add(SPREAD)
        self.journal.record(self.trade, 'taken', 0.45)
        with og.closing(og.sqlite3.connect(self.journal.path)) as db, db:  # Taken at 10:00 New York.
            db.execute('UPDATE suggestions SET opened_ts=?', (datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc).timestamp(),))

    def tearDown(self):
        self.directory.cleanup()

    def test_the_trailing_stop_closes_a_winner_before_it_turns_into_a_loss(self):
        state = ow.watch(self.journal.open_trades()[0], bars(RISE_AND_FALL))
        self.assertLess(state['now_pnl'], 0)  # Held on, it lost.
        trailing = [e for e in state['events'] if e['event'] == 'trailing stop']
        self.assertEqual(len(trailing), 1)
        self.assertGreaterEqual(trailing[0]['pnl'], ow.FLOOR_MIN * 0.5)  # Closed while still in profit.
        self.assertLess(trailing[0]['pnl'], state['best_pnl'])
        # A trade that never gets far enough up has no trailing floor.
        flat = ow.watch(self.journal.open_trades()[0], bars([500 - i / 300 for i in range(90)]))
        self.assertIsNone(flat['trailing_floor'])
        self.assertFalse([e for e in flat['events'] if e['event'] == 'trailing stop'])

    def test_each_exit_sets_up_the_closing_order_and_is_sent_once(self):
        alerts, said, setups = ow.Alerts(self.journal.path), [], []

        async def set_up(state, legs):
            setups.append(legs)
            return {'result': 'ready_for_owner', 'estimate': 'credit $47.00', 'mouse_on': 'Review order'}

        now = DAY.replace(hour=12, minute=30)
        run = lambda: asyncio.run(ow.check(self.journal, alerts, now, set_up, lambda t: bars(RISE_AND_FALL), said.append))
        sent = run()
        self.assertEqual([a['event'] for a in sent], ['trailing stop'])
        self.assertEqual(setups[0], [{**SPREAD['legs'][0], 'action': 'sell'}, {**SPREAD['legs'][1], 'action': 'buy'}])
        self.assertIn('press Review order', said[0]['message'])
        self.assertEqual(run(), [])  # Already sent.

    def test_a_failed_set_up_still_tells_the_owner(self):
        async def broken(state, legs):
            raise LookupError('no Robinhood tab')

        said = []
        asyncio.run(ow.check(self.journal, ow.Alerts(self.journal.path), DAY.replace(hour=12, minute=30), broken,
                             lambda t: bars(RISE_AND_FALL), said.append))
        self.assertIn('close it on Robinhood yourself', said[0]['message'])


if __name__ == '__main__':
    unittest.main()
