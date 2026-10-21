import asyncio
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import autopilot as ap
import options_guide as og
import options_watch as ow

SPREAD = {'kind': 'decay spread', 'ticker': 'SPY', 'expiry': '2026-10-23', 'days': 2, 'qty': 1, 'price': 0.30,
          'limit': 0.30, 'max_loss': 70.0,
          'legs': [{'action': 'sell', 'type': 'put', 'strike': 770, 'iv': 0.2},
                   {'action': 'buy', 'type': 'put', 'strike': 769, 'iv': 0.2}]}
OPEN_ET = datetime(2026, 10, 21, 11, 0)  # A Wednesday, 11am New York.

# What Robinhood shows (read from the live site, 2026-10-21).
FORM = ('Put Credit Spread\nContracts\n100 Shares Each\nLimit Price\nBid $0.28 • Ask $0.32\nTime in force\n'
        'Good for Day\nEstimated credit\n$29.96\n$0.30 × 100 multiplier × 1 contract\n$0.04 est regulatory fee')
BROKE = ('Call Credit Spread\nContracts\nEstimated credit\n$70.92\n$0.71 × 100 multiplier × 1 contract\n'
         'Collateral\n$500.00\nNot Enough Buying Power')


class Base(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home, ap.HOME = ap.HOME, Path(self.directory.name) / 'autopilot'
        self.journal = og.Journal(Path(self.directory.name) / 'j.sqlite')
        self.orders = ap.Orders(self.journal.path)

    def tearDown(self):
        ap.HOME = self.home
        self.directory.cleanup()

    def score(self, kind: str, wins: int, losses: int):
        """Fake managed results for a kind."""
        for i in range(wins + losses):
            identity = self.journal.add({**SPREAD, 'kind': kind, 'legs': [{**SPREAD['legs'][0], 'strike': 700 + i}]})
            with og.closing(og.sqlite3.connect(self.journal.path)) as db, db:
                db.execute("UPDATE suggestions SET managed_pnl=?, status='skipped' WHERE id=?",
                           (5.0 if i < wins else -10.0, identity))


def morning() -> float:
    """10am New York today, as a timestamp."""
    et = og.now_eastern()
    return time.time() - ((et.hour * 60 + et.minute) - 600) * 60


class SwitchTests(Base):
    def test_only_the_pin_turns_it_on_and_a_tampered_state_reads_as_off(self):
        at = morning()
        with self.assertRaisesRegex(PermissionError, 'No PIN yet'):
            ap.turn_on('123456', 'dry_run', self.journal, at)
        with self.assertRaisesRegex(ValueError, '6 to 12 digits'):
            ap.set_pin('123')
        ap.set_pin('482913')
        with self.assertRaisesRegex(PermissionError, 'current PIN is wrong'):
            ap.set_pin('111111', old='000000')
        with self.assertRaisesRegex(PermissionError, 'Wrong PIN'):
            ap.turn_on('000000', 'dry_run', self.journal, at)
        on = ap.turn_on('482913', 'dry_run', self.journal, at)
        self.assertEqual(on['mode'], 'dry_run')
        self.assertAlmostEqual(on['until'] - at, 6 * 3600, delta=90)  # Off by itself at 4pm.
        # Someone edits the state file to live: the signature no longer matches.
        saved = json.loads((ap.HOME / 'state.json').read_text())
        (ap.HOME / 'state.json').write_text(json.dumps({**saved, 'mode': 'live'}))
        self.assertEqual(ap.state(at)['mode'], 'off')
        self.assertIn('not signed', ap.state(at)['note'])
        with self.assertRaisesRegex(ValueError, 'closed for today'):
            ap.turn_on('482913', 'dry_run', self.journal, at + 7 * 3600)

    def test_wrong_pins_lock_it(self):
        ap.set_pin('482913')
        for _ in range(ap.MAX_WRONG):
            with self.assertRaises(PermissionError):
                ap.turn_on('000000', 'dry_run', self.journal, morning())
        with self.assertRaisesRegex(PermissionError, 'Too many wrong PINs'):
            ap.turn_on('482913', 'dry_run', self.journal, morning())  # Even the right PIN, until the lock cools down.

    def test_it_turns_itself_off_at_the_close_and_off_needs_no_pin(self):
        ap.set_pin('482913')
        saved = {'mode': 'dry_run', 'until': time.time() - 1, 'at': time.time() - 100}
        saved['sig'] = ap._sign(saved)
        (ap.HOME / 'state.json').write_text(json.dumps(saved))
        self.assertEqual(ap.state()['mode'], 'off')
        self.assertEqual(ap.turn_off(), {'mode': 'off'})

    def test_live_needs_the_minimum_record(self):
        ap.set_pin('482913')
        self.score('decay spread', 15, 4)  # 19 scored: one short.
        with self.assertRaisesRegex(PermissionError, 'minimum record'):
            ap.turn_on('482913', 'live', self.journal, morning())
        self.score('decay spread', 1, 0)
        self.assertEqual(ap.qualified(self.journal), ['decay spread'])
        self.assertEqual(ap.turn_on('482913', 'live', self.journal, morning())['mode'], 'live')
        self.score('debit spread', 15, 10)  # 60% wins: never qualifies.
        self.assertNotIn('debit spread', ap.qualified(self.journal))


class CheckTests(Base):
    def test_entries_are_checked_against_the_rules(self):
        s = {**SPREAD, 'id': self.journal.add(SPREAD)}
        self.assertEqual(ap.check_entry(self.journal, self.orders, s, 'dry_run', OPEN_ET), [])
        self.assertIn('minimum record', ' '.join(ap.check_entry(self.journal, self.orders, s, 'live', OPEN_ET)))
        too_big = {**s, 'max_loss': 150}
        self.assertIn('over $100', ' '.join(ap.check_entry(self.journal, self.orders, too_big, 'dry_run', OPEN_ET)))
        late = OPEN_ET.replace(hour=15, minute=40)
        self.assertIn('Outside', ' '.join(ap.check_entry(self.journal, self.orders, s, 'dry_run', late)))
        self.assertIn('not one of', ' '.join(ap.check_entry(self.journal, self.orders, {**s, 'ticker': 'GME'}, 'dry_run', OPEN_ET)))
        self.assertIn('not in the journal', ' '.join(ap.check_entry(self.journal, self.orders, {**s, 'id': 'nope'}, 'dry_run', OPEN_ET)))
        for _ in range(ap.MAX_ENTRIES_PER_DAY):
            self.orders.add('x', 'entry', 'live', 'submitted', {})
        self.assertIn('Already', ' '.join(ap.check_entry(self.journal, self.orders, s, 'dry_run', og.now_eastern().replace(hour=11))))
        self.journal.record(s['id'], 'taken', 0.30)
        self.assertIn('already open', ' '.join(ap.check_entry(self.journal, self.orders, s, 'dry_run', OPEN_ET)))

    def test_exits_must_reverse_the_open_trade(self):
        trade = self.journal.add(SPREAD)
        self.journal.record(trade, 'taken', 0.30)
        self.assertEqual(ap.check_exit(self.journal, trade, ow.closing_legs(SPREAD['legs']), 1), [])
        self.assertTrue(ap.check_exit(self.journal, trade, SPREAD['legs'], 1))  # Same direction: would add, not close.
        self.assertTrue(ap.check_exit(self.journal, trade, ow.closing_legs(SPREAD['legs']), 2))
        self.assertTrue(ap.check_exit(self.journal, 'other', ow.closing_legs(SPREAD['legs']), 1))

    def test_the_form_is_read_back(self):
        self.assertEqual(ap.check_form(FORM, 1, 0.30, 100, 'Put Credit Spread'), [])
        self.assertIn('2 contracts', ' '.join(ap.check_form(FORM.replace('× 1 contract', '× 2 contract'), 1, 0.30, 100)))
        self.assertIn('limit of $0.30', ' '.join(ap.check_form(FORM, 1, 0.45, 100)))
        self.assertIn('not a Call Credit Spread', ' '.join(ap.check_form(FORM, 1, 0.30, 100, 'Call Credit Spread')))
        broke = ' '.join(ap.check_form(BROKE, 1, 0.71, 100))
        self.assertIn('$429.08 at risk', broke)  # $500 collateral less $70.92 credit.
        self.assertIn('buying power', broke)
        self.assertIn('Could not read', ' '.join(ap.check_form('nothing here', 1, 0.30, 100)))
        self.assertEqual(ap.title_for(SPREAD['legs'], True), 'Put Credit Spread')


PAGE = '''<div id="panel"><h3>{title}</h3><p>Contracts</p><p>Limit Price</p><p>Estimated credit</p><p>$29.96</p>
<p>$0.30 × 100 multiplier × 1 contract</p>
<button id="review" onclick="document.getElementById('panel').innerHTML=REVIEW">Review order</button></div>
<script>const REVIEW = `<h3>{title}</h3><p>{words}</p><p>Limit Price</p><p>$0.30 × 100 multiplier × 1 contract</p>
<button onclick="window.submitted=true">Submit order</button><button>Go to Edit</button>`;</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in headless Chrome test')
class PlaceTests(Base):
    """A fake order page: the real one is never used in tests."""

    async def run_place(self, mode, side='entry', words='Sell to Open', problems=()):
        from playwright.async_api import async_playwright
        if mode != 'off':
            if not ap.pin_set():
                ap.set_pin('482913')
            saved = {'mode': mode, 'until': time.time() + 600, 'at': time.time()}
            saved['sig'] = ap._sign(saved)
            (ap.HOME / 'state.json').write_text(json.dumps(saved))
        async with async_playwright() as pw:
            chrome = await pw.chromium.launch(channel='chrome', headless=True)
            try:
                page = await chrome.new_page()
                await page.set_content(PAGE.replace('{title}', 'Put Credit Spread').replace('{words}', words))
                result = await ap.place(page, side, 't1', SPREAD['legs'], 1, 0.30, 100.0, self.orders, list(problems),
                                        'Put Credit Spread', pause=lambda s: asyncio.sleep(0.1))
                return result, await page.evaluate('() => !!window.submitted')
            finally:
                await chrome.close()

    def test_submit_is_pressed_only_live_and_only_when_everything_checks(self):
        result, submitted = asyncio.run(self.run_place('off'))
        self.assertEqual((result['result'], submitted), ('refused', False))
        result, submitted = asyncio.run(self.run_place('dry_run'))
        self.assertEqual((result['result'], submitted), ('dry_run', False))
        self.assertIn('Submit order', result['why'][0])
        result, submitted = asyncio.run(self.run_place('live', problems=['A trade is already open.']))
        self.assertEqual((result['result'], submitted), ('refused', False))
        # An exit the page does not show as closing (no position to close): refused.
        result, submitted = asyncio.run(self.run_place('live', side='exit'))
        self.assertEqual((result['result'], submitted), ('refused', False))
        result, submitted = asyncio.run(self.run_place('live'))
        self.assertEqual((result['result'], result['pressed'], submitted), ('submitted', 'Submit order', True))
        self.assertEqual([o['result'] for o in self.orders.recent()][:1], ['submitted'])


class EnterTests(Base):
    def test_the_listener_enters_the_first_suggestion_that_passes(self):
        ap.set_pin('482913')
        saved = {'mode': 'dry_run', 'until': time.time() + 600, 'at': time.time()}
        saved['sig'] = ap._sign(saved)
        (ap.HOME / 'state.json').write_text(json.dumps(saved))
        good = {**SPREAD, 'id': self.journal.add(SPREAD)}
        bad = {**SPREAD, 'ticker': 'GME', 'id': 'x'}
        said, placed_with = [], []

        async def set_up(s):
            return {'limit': 0.31}

        async def place(s, ready, extra, title):
            placed_with.append((s['id'], extra, title))
            return {'result': 'dry_run', 'why': ['Would press "Submit order".'], 'mode': 'dry_run'}

        result = asyncio.run(ow.enter(self.journal, self.orders, OPEN_ET, lambda: [bad, good], set_up, place, said.append))
        self.assertEqual(result['result'], 'dry_run')
        self.assertEqual(placed_with, [(good['id'], [], 'Put Credit Spread')])
        self.assertIn('Dry run', said[0]['message'])
        self.assertEqual(self.journal.open_trades(), [])  # A dry run takes nothing.

        async def worse(s):
            return {'limit': 0.20}  # Live mid a third below the planned credit.

        asyncio.run(ow.enter(self.journal, self.orders, OPEN_ET, lambda: [good], worse, place, said.append))
        self.assertIn('worse than planned', placed_with[-1][1][0])


if __name__ == '__main__':
    unittest.main()
