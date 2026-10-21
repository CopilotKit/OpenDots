import tempfile
import unittest
from pathlib import Path

import option_history as oh

ROW = {'contractID': 'SPY240805P00500000', 'symbol': 'SPY', 'expiration': '2024-08-07', 'strike': '500.00', 'type': 'put',
       'last': '1.10', 'mark': '1.12', 'bid': '1.10', 'ask': '1.14', 'volume': '100', 'open_interest': '2000',
       'implied_volatility': '0.31', 'delta': '-0.21'}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store, oh.STORE = oh.STORE, Path(self.directory.name)
        self.key = oh.api_key

    def tearDown(self):
        oh.STORE, oh.api_key = self.store, self.key
        self.directory.cleanup()

    def test_days_are_parsed_cached_and_kept_within_the_daily_budget(self):
        calls = []

        def get(params):
            calls.append(params)
            return {'endpoint': 'Historical Options', 'data': [ROW, {'junk': 1}]}

        budget = oh.Budget(limit=3)
        oh.api_key = lambda: 'test'
        rows = oh.fetch('SPY', '2024-08-05', budget, get)
        self.assertEqual(rows, [{'expiry': '2024-08-07', 'strike': 500.0, 'call': False, 'bid': 1.1, 'ask': 1.14,
                                 'iv': 0.31, 'delta': -0.21, 'volume': 100.0, 'oi': 2000.0}])
        self.assertEqual(oh.fetch('SPY', '2024-08-05', budget, get), rows)  # From disk: no second request.
        self.assertEqual(len(calls), 1)
        result = oh.fetch_next(budget, get, log=lambda *a: None)
        self.assertEqual(result['downloaded'], 2)  # The budget's last two.
        self.assertEqual(budget.left(), 0)
        with self.assertRaisesRegex(RuntimeError, 'budget is used up'):
            oh.fetch('QQQ', '2024-08-06', budget, get)

    def test_a_refusal_is_reported_and_not_saved(self):
        oh.api_key = lambda: 'test'
        refuse = lambda params: {'Information': 'This is a premium endpoint.'}
        with self.assertRaisesRegex(RuntimeError, 'premium endpoint'):
            oh.fetch('SPY', '2024-08-05', oh.Budget(limit=5), refuse)
        self.assertIsNone(oh.saved('SPY', '2024-08-05'))

    def test_the_plan_starts_with_the_bad_weeks(self):
        first = oh.plan()[:2]
        self.assertEqual([(s, d) for _, s, d in first], [('SPY', '2024-07-24'), ('QQQ', '2024-07-24')])
        self.assertTrue(all(oh.date.fromisoformat(d).weekday() < 5 for _, _, d in oh.plan()))


if __name__ == '__main__':
    unittest.main()
