import json
import tempfile
import unittest
from pathlib import Path

import order_guard


class OrderGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.real = order_guard.POLICY_FILE
        order_guard.POLICY_FILE = Path(self.directory.name) / 'policy.json'
        order_guard.POLICY_FILE.write_text(json.dumps({'ownerPressesOrders': ['robinhood.com', 'draftkings.com']}))

    def tearDown(self):
        order_guard.POLICY_FILE = self.real
        self.directory.cleanup()

    def test_bet_buttons_are_the_owners_on_draftkings(self):
        url = 'https://sportsbook.draftkings.com/leagues/football/nfl'
        for label in ('Place Bet', 'Place $10.00 Bet', 'Place 3 Bets', 'Confirm Wager', 'Bet Now',
                      'Accept odds changes and place', 'Place Parlay'):
            with self.assertRaises(PermissionError, msg=label):
                order_guard.check_click(url, label)
        for label in ('Add to Bet Slip', 'Bet Slip', 'NFL', 'Moneyline -110', 'My Bets', 'Remove all'):
            order_guard.check_click(url, label)  # Preparing the slip stays allowed.

    def test_robinhood_still_guarded_and_other_sites_untouched(self):
        with self.assertRaises(PermissionError):
            order_guard.check_click('https://robinhood.com/options/chains/SPY', 'Review order')
        order_guard.check_click('https://robinhood.com/options/chains/SPY', 'Continue')
        order_guard.check_click('https://example.com/shop', 'Place Bet')  # Not an owner-presses site.


if __name__ == '__main__':
    unittest.main()
