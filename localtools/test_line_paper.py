import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

import line_paper as lp
import nba_research as nr
import sport_lines as sl
import sports_picks as sp

NOW = datetime(2026, 10, 27, 15, 0, tzinfo=timezone.utc)


def history():
    out = []
    for k in range(8):  # Strong Seahawks, weak Jets.
        day = f'2026-09-{k + 1:02d}'
        out.append({'date': day, 'home': 'Seattle Seahawks', 'away': 'Las Vegas Raiders', 'home_pts': 35, 'away_pts': 14, 'id': f'a{k}'})
        out.append({'date': day, 'home': 'New York Jets', 'away': 'Miami Dolphins', 'home_pts': 10, 'away_pts': 27, 'id': f'b{k}'})
    return out


class Response:
    def __init__(self, body):
        self.body, self.headers = body, {'x-requests-remaining': '400', 'x-requests-used': '100'}

    def raise_for_status(self):
        pass

    def json(self):
        return self.body


class LinePaperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.bets = lp.Bets(Path(self.directory.name) / 'b.sqlite')
        self.saved = (sl.games, sp.api_key, sp.USAGE)
        sp.api_key, sp.USAGE = (lambda: 'test'), Path(self.directory.name) / 'u.json'
        sl.games = lambda key, end=None: history()

    def tearDown(self):
        sl.games, sp.api_key, sp.USAGE = self.saved
        self.directory.cleanup()

    def odds(self, home_spread):
        return [{'id': 'e1', 'home_team': 'Seattle Seahawks', 'away_team': 'New York Jets', 'commence_time': '2026-10-30T00:15:00Z',
                 'bookmakers': [{'key': 'draftkings', 'markets': [{'key': 'spreads', 'outcomes': [
                     {'name': 'Seattle Seahawks', 'price': -110, 'point': home_spread},
                     {'name': 'New York Jets', 'price': -110, 'point': -home_spread}]}]}]}]

    def test_a_bet_when_the_model_beats_the_spread_by_the_threshold_once_per_game(self):
        result = lp.scan('NFL', self.bets, lambda url, params, timeout: Response(self.odds(-3.5)), now=NOW)
        self.assertEqual([b['side'] for b in result['placed']], ['home'])  # The model has Seattle by ~37.
        self.assertEqual(lp.scan('NFL', self.bets, lambda url, params, timeout: Response(self.odds(-3.5)), now=NOW)['placed'], [])
        self.bets = lp.Bets(Path(self.directory.name) / 'c.sqlite')
        self.assertEqual(lp.scan('NFL', self.bets, lambda url, params, timeout: Response(self.odds(-36.5)), now=NOW)['placed'], [])

    def test_settling_from_final_scores(self):
        lp.scan('NFL', self.bets, lambda url, params, timeout: Response(self.odds(-3.5)), now=NOW)
        final = {'date': '2026-10-29', 'home': 'Seattle Seahawks', 'away': 'New York Jets', 'home_pts': 24, 'away_pts': 17, 'id': 'z'}
        sl.games = lambda key, end=None: history() + [final]
        result = lp.settle(self.bets, today=date(2026, 10, 31))
        self.assertEqual(result['settled'], 1)
        self.assertEqual(self.bets.rows()[0]['result'], 'won')  # Won by 7, covering -3.5.
        self.assertAlmostEqual(self.bets.rows()[0]['profit'], round(10 * nr.payout(-110), 2))


if __name__ == '__main__':
    unittest.main()
