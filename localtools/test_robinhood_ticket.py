import unittest

from robinhood_ticket import check_legs


class LegTests(unittest.TestCase):
    def test_legs_are_checked_and_normalized(self):
        legs = check_legs([{'action': 'Sell', 'type': 'PUT', 'strike': '776'}, {'action': 'buy', 'type': 'put', 'strike': 775}])
        self.assertEqual(legs, [{'action': 'sell', 'type': 'put', 'strike': 776.0}, {'action': 'buy', 'type': 'put', 'strike': 775.0}])
        for bad in ([], [{'action': 'hold', 'type': 'put', 'strike': 1}], [{'action': 'buy', 'type': 'stock', 'strike': 1}],
                    [{'action': 'buy', 'type': 'put', 'strike': 1}] * 5):
            with self.assertRaises(ValueError):
                check_legs(bad)


if __name__ == '__main__':
    unittest.main()
