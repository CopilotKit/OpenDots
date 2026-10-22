import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sports_picks as sp

NOW = datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc)


def book(key, h2h, totals=None):
    markets = [{'key': 'h2h', 'outcomes': [{'name': n, 'price': p} for n, p in h2h]}]
    if totals:
        markets.append({'key': 'totals', 'outcomes': [{'name': n, 'price': p, 'point': pt} for n, p, pt in totals]})
    return {'key': key, 'markets': markets}


def event(eid, home, away, books, hours=5):
    return {'id': eid, 'sport_key': 'basketball_nba', 'home_team': home, 'away_team': away,
            'commence_time': (NOW + timedelta(hours=hours)).isoformat().replace('+00:00', 'Z'), 'bookmakers': books}


class Response:
    def __init__(self, body, remaining=400):
        self.body, self.headers = body, {'x-requests-remaining': str(remaining), 'x-requests-used': '100'}

    def raise_for_status(self):
        pass

    def json(self):
        return self.body


class PicksTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.usage, sp.USAGE = sp.USAGE, Path(self.directory.name) / 'usage.json'
        self.key, sp.api_key = sp.api_key, lambda: 'test'

    def tearDown(self):
        sp.USAGE, sp.api_key = self.usage, self.key
        self.directory.cleanup()

    def test_the_margin_is_removed(self):
        fair = sp.no_vig([{'name': 'A', 'price': 1.91}, {'name': 'B', 'price': 1.91}])
        self.assertAlmostEqual(fair[('A', None)], 0.5)
        self.assertAlmostEqual(sum(fair.values()), 1.0)

    def test_an_edge_needs_draftkings_to_pay_more_than_the_fair_chance(self):
        games = [event('g1', 'Lakers', 'Kings', [
            book('draftkings', [('Lakers', 1.60), ('Kings', 2.30)]),
            book('pinnacle', [('Lakers', 1.50), ('Kings', 2.70)]),  # Fair: Lakers ~64%.
        ])]
        found = {p['name']: p for p in sp.picks(games, NOW)}
        self.assertEqual(found['Lakers']['source'], 'Pinnacle')
        self.assertGreater(found['Lakers']['edge'], 0.02)  # 0.643 x 1.60 - 1 = +2.9%.
        self.assertLess(found['Kings']['edge'], 0)
        # No sharp book: the median of at least 3 others; 2 are not enough.
        two = [event('g2', 'Heat', 'Nets', [book('draftkings', [('Heat', 1.8), ('Nets', 2.1)]),
                                            book('fanduel', [('Heat', 1.7), ('Nets', 2.2)]),
                                            book('betmgm', [('Heat', 1.7), ('Nets', 2.2)])])]
        self.assertEqual(sp.picks(two, NOW), [])
        # Started or too far out: left alone.
        self.assertEqual(sp.picks([{**games[0], 'commence_time': (NOW - timedelta(hours=1)).isoformat()}], NOW), [])

    def test_parlays_pair_edge_picks_from_different_games(self):
        legs = [{'event': e, 'market': 'h2h', 'name': n, 'point': None, 'price': pr, 'fair': f, 'edge': f * pr - 1,
                 'home': 'H', 'away': 'A', 'sport': 's', 'start': '', 'source': 'Pinnacle'}
                for e, n, pr, f in (('g1', 'A1', 1.6, 0.66), ('g1', 'B1', 1.5, 0.70), ('g2', 'A2', 1.7, 0.62),
                                    ('g3', 'A3', 3.0, 0.36), ('g4', 'A4', 1.4, 0.70))]
        found = sp.parlays(legs, top=5)
        for p in found:
            self.assertNotEqual(p['legs'][0]['event'], p['legs'][1]['event'])
            self.assertGreaterEqual(p['hit'], sp.MIN_HIT)
            self.assertGreater(p['ev'], 0)
            self.assertAlmostEqual(p['price'], p['legs'][0]['price'] * p['legs'][1]['price'], places=3)
        self.assertNotIn('A4', [l['name'] for p in found for l in p['legs']])  # No edge (0.70 x 1.4 < 1).
        names = [l['name'] for p in found for l in p['legs']]
        self.assertEqual(len(names), len(set(names)))  # Each pick in one parlay at most.

    def test_credits_are_tracked_and_the_reserve_kept(self):
        sp.get('/sports', {}, 0, lambda url, params, timeout: Response([], remaining=sp.RESERVE + 2))
        self.assertEqual(sp.credits_left(), sp.RESERVE + 2)
        with self.assertRaisesRegex(RuntimeError, 'credits low'):
            sp.get('/sports/x/odds', {}, 3, lambda url, params, timeout: Response([]))


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = sp.Journal(Path(self.directory.name) / 'j.sqlite')

    def tearDown(self):
        self.directory.cleanup()

    def leg(self, eid, market, name, point, price):
        return {'event': eid, 'market': market, 'name': name, 'point': point, 'price': price, 'fair': 0.6, 'edge': 0.03,
                'home': 'Lakers', 'away': 'Kings', 'sport': 'basketball_nba', 'start': '', 'source': 'Pinnacle'}

    def test_parlays_settle_from_final_scores(self):
        won = self.journal.add({'legs': [self.leg('g1', 'h2h', 'Lakers', None, 1.6), self.leg('g2', 'totals', 'Over', 220.5, 1.9)],
                                'price': 3.04, 'hit': 0.36, 'ev': 0.09})
        lost = self.journal.add({'legs': [self.leg('g1', 'spreads', 'Kings', 3.5, 1.9), self.leg('g2', 'totals', 'Under', 220.5, 1.9)],
                                 'price': 3.61, 'hit': 0.36, 'ev': 0.3})
        pushed = self.journal.add({'legs': [self.leg('g1', 'spreads', 'Lakers', -5.0, 1.9), self.leg('g2', 'h2h', 'Lakers', None, 1.5)],
                                   'price': 2.85, 'hit': 0.36, 'ev': 0.03})
        self.assertEqual(self.journal.settle({'g1': {'home_team': 'Lakers', 'away_team': 'Kings', 'home': 110, 'away': 105}}), 0)  # g2 not final.
        finals = {'g1': {'home_team': 'Lakers', 'away_team': 'Kings', 'home': 110, 'away': 105},
                  'g2': {'home_team': 'Lakers', 'away_team': 'Kings', 'home': 115, 'away': 112}}
        self.assertEqual(self.journal.settle(finals), 3)
        rows = {r['id']: r for r in self.journal.rows()}
        self.assertEqual((rows[won]['status'], rows[won]['payout']), ('won', round(10 * (1.6 * 1.9 - 1), 2)))
        self.assertEqual((rows[lost]['status'], rows[lost]['payout']), ('lost', -10.0))  # Kings +3.5 lost by 5.
        self.assertEqual((rows[pushed]['status'], rows[pushed]['payout']), ('won', 5.0))  # Lakers -5 pushed; the 1.5 leg won.
        summary = self.journal.summary()
        self.assertEqual((summary['parlays'], summary['hit_rate']), (3, round(2 / 3, 3)))

    def test_the_same_parlay_is_logged_once_a_day(self):
        p = {'legs': [self.leg('g1', 'h2h', 'Lakers', None, 1.6), self.leg('g2', 'h2h', 'Heat', None, 1.7)],
             'price': 2.72, 'hit': 0.36, 'ev': 0.0}
        self.assertEqual(self.journal.add(p), self.journal.add(dict(p)))


if __name__ == '__main__':
    unittest.main()
