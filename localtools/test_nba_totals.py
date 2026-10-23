import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import nba_extra
import nba_lines
import nba_data
import nba_research as nr
import nba_totals as nt
import sports_picks as sp

NOW = datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc)


def game(gid, day, home, away, hs, as_, pace=100):
    t = {'fga': pace * 0.88, 'oreb': 10, 'tov': 13, 'fta': pace * 0.25}
    return {'id': gid, 'date': day, 'home': home, 'away': away, 'score': {'home': hs, 'away': as_},
            'teams': {'home': dict(t), 'away': dict(t)}, 'line': {'total': 220, 'home_spread': -3}}


class Response:
    def __init__(self, body):
        self.body, self.headers = body, {'x-requests-remaining': '400', 'x-requests-used': '100'}

    def raise_for_status(self):
        pass

    def json(self):
        return self.body


class TotalsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.bets = nt.Bets(Path(self.directory.name) / 'b.sqlite')
        self.saved = (nba_extra.load_all, sp.api_key, sp.USAGE, nba_data.games_on, nba_extra.extra, nba_lines.moves)
        sp.api_key, sp.USAGE = (lambda: 'test'), Path(self.directory.name) / 'usage.json'
        # Two high-scoring teams: 10 games each of 130-125.
        history = [game(f'g{k}', f'2026-11-{k + 1:02d}', 'Denver Nuggets', 'Utah Jazz', 130, 125) for k in range(10)]
        nba_extra.load_all = lambda log=None: history

    def tearDown(self):
        nba_extra.load_all, sp.api_key, sp.USAGE, nba_data.games_on, nba_extra.extra, nba_lines.moves = self.saved
        self.directory.cleanup()

    def odds(self, line):
        return [{'id': 'e1', 'home_team': 'Denver Nuggets', 'away_team': 'Utah Jazz', 'commence_time': '2026-11-21T02:00:00Z',
                 'bookmakers': [{'key': 'draftkings', 'markets': [{'key': 'totals', 'outcomes': [
                     {'name': 'Over', 'price': -110, 'point': line}, {'name': 'Under', 'price': -110, 'point': line}]}]}]}]

    def test_a_bet_when_the_model_and_the_early_line_disagree_and_once_per_game(self):
        http = lambda url, params, timeout: Response(self.odds(230.5))
        result = nt.scan(self.bets, http, now=NOW)
        self.assertEqual(len(result['placed']), 1)
        bet = result['placed'][0]
        self.assertEqual(bet['side'], 'over')  # The model sees ~255.
        self.assertGreater(bet['model'], 245)
        self.assertEqual(nt.scan(self.bets, http, now=NOW)['placed'], [])  # The first line counts.
        # Close to the model: no bet.
        self.bets = nt.Bets(Path(self.directory.name) / 'c.sqlite')
        self.assertEqual(nt.scan(self.bets, lambda url, params, timeout: Response(self.odds(254.5)), now=NOW)['placed'], [])

    def test_settling_records_the_result_and_whether_the_line_moved_our_way(self):
        nt.scan(self.bets, lambda url, params, timeout: Response(self.odds(230.5)), now=NOW)
        nba_data.games_on = lambda day: [{'id': 'x', 'home': 'Denver Nuggets', 'away': 'Utah Jazz', 'final': True}]
        nba_extra.extra = lambda gid: {'score': {'home': 120, 'away': 115}}
        nba_lines.moves = lambda gid: {'close_total': 234.5}
        result = nt.settle(self.bets, today=nt.date(2026, 11, 22))
        row = self.bets.rows()[0]
        self.assertEqual((result['settled'], row['result'], row['clv']), (1, 'won', 4.0))  # 235 > 230.5; line moved 4 our way.
        self.assertAlmostEqual(row['profit'], round(10 * nr.payout(-110), 2))
        self.assertEqual(result['line_moved_our_way'], 1.0)


if __name__ == '__main__':
    unittest.main()
