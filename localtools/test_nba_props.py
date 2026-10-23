import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import nba_data
import nba_props as nb
import sports_picks as sp


def history(points=(20,) * 20, minutes=32.0, player='Jalen Brunson', team='New York Knicks', opponent='Boston Celtics'):
    rows, day = [], date(2026, 1, 1)
    for k, pts in enumerate(points):
        g = f'g{k}'
        rows.append({'player': player, 'id': '1', 'team': team, 'opponent': opponent, 'home': True, 'min': minutes,
                     'pts': pts, 'fga': 15, 'fta': 4, 'starter': True, 'date': (day + timedelta(days=2 * k)).isoformat(), 'game': g})
        rows.append({'player': 'Other Guy', 'id': '2', 'team': opponent, 'opponent': team, 'home': False, 'min': 30.0,
                     'pts': 20, 'fga': 20, 'fta': 5, 'starter': True, 'date': (day + timedelta(days=2 * k)).isoformat(), 'game': g})
    return rows


class ModelTests(unittest.TestCase):
    def test_scoring_is_lopsided_so_the_typical_night_sits_below_the_average(self):
        self.assertLess(nb.chance_over(20.0, 19.5, 1.6, 0.06), 0.5)
        self.assertGreater(nb.chance_over(20.0, 10.5, 1.6, 0.06), 0.9)
        self.assertLess(nb.chance_over(20.0, 35.5, 1.6, 0.06), 0.05)
        wide, narrow = nb.chance_over(20.0, 30.5, 1.6, 0.12), nb.chance_over(20.0, 30.5, 1.6, 0.02)
        self.assertGreater(wide, narrow)  # A wider spread: big nights more likely.

    def test_the_projection_needs_enough_games_and_weights_recent_ones(self):
        self.assertIsNone(nb.projection([{'min': 30.0, 'pts': 20}] * 5))
        steady = nb.projection([{'min': 30.0, 'pts': 15}] * 12)
        self.assertAlmostEqual(steady['mean'], 15.0, places=6)
        heating = nb.projection([{'min': 30.0, 'pts': 10}] * 10 + [{'min': 30.0, 'pts': 25}] * 5)
        self.assertGreater(heating['mean'], 15.0)  # More weight on the last five.
        self.assertAlmostEqual(nb.projection([{'min': 30.0, 'pts': 15}] * 12, 1.1)['mean'], 16.5, places=6)

    def test_names_match_across_sources(self):
        self.assertEqual(nb.norm('Jaren Jackson Jr.'), nb.norm('Jaren Jackson'))
        self.assertEqual(nb.norm("De'Aaron Fox"), nb.norm('DeAaron Fox'))


class PropTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = sp.Journal(Path(self.directory.name) / 'j.sqlite')

    def tearDown(self):
        self.directory.cleanup()

    def event(self, over, under, others=(), when='2026-03-01T00:30:00Z', point=24.5, home='New York Knicks'):
        def bk(key, o, u):
            return {'key': key, 'markets': [{'key': 'player_points', 'outcomes': [
                {'name': 'Over', 'description': 'Jalen Brunson', 'price': o, 'point': point},
                {'name': 'Under', 'description': 'Jalen Brunson', 'price': u, 'point': point}]}]}
        return {'id': 'e1', 'home_team': home, 'away_team': 'Boston Celtics', 'commence_time': when,
                'bookmakers': [bk('draftkings', over, under)] + [bk(k, o, u) for k, o, u in others]}

    def test_a_prop_qualifies_only_with_our_edge_and_the_market_agreeing(self):
        h = nb.History(history(points=(20,) * 20))  # Averages 20.
        agree = [('fanduel', 2.1, 1.75), ('betmgm', 2.1, 1.75)]  # The market leans under too.
        legs = {l['name']: l for l in nb.evaluate(self.event(1.9, 1.9, agree, point=21.5), h, {}, None, (1.6, 0.06))}
        self.assertTrue(nb.MIN_EDGE <= legs['Under']['edge'] <= nb.MAX_EDGE, legs['Under']['edge'])
        self.assertGreaterEqual(legs['Under']['market_edge'], nb.MARKET_FLOOR)
        self.assertTrue(nb.qualifies(legs['Under']))
        self.assertFalse(nb.qualifies(legs['Over']))
        # No other books to check against: not taken.
        alone = {l['name']: l for l in nb.evaluate(self.event(1.9, 1.9, point=21.5), h, {}, None, (1.6, 0.06))}
        self.assertFalse(nb.qualifies(alone['Under']))
        # The market prices the under far higher (it knows something): not taken.
        doubt = {l['name']: l for l in nb.evaluate(self.event(1.9, 1.9, [('fanduel', 1.25, 4.0), ('betmgm', 1.25, 4.0)], point=21.5),
                                                   h, {}, None, (1.6, 0.06))}
        self.assertLess(doubt['Under']['market_edge'], nb.MARKET_FLOOR)
        self.assertFalse(nb.qualifies(doubt['Under']))
        # An edge too big to be real (line far from anything he scores): treated as a model error.
        huge = {l['name']: l for l in nb.evaluate(self.event(1.9, 1.9, agree, point=30.5), h, {}, None, (1.6, 0.06))}
        self.assertGreater(huge['Under']['edge'], nb.MAX_EDGE)
        self.assertFalse(nb.qualifies(huge['Under']))
        # Listed out, or now on another team: nothing.
        self.assertEqual(nb.evaluate(self.event(1.9, 1.9, agree), h, {'Jalen Brunson': 'Out'}, None, (1.6, 0.06)), [])
        self.assertEqual(nb.evaluate(self.event(1.9, 1.9, agree, home='Miami Heat'), h, {}, None, (1.6, 0.06)), [])

    def test_history_counts_from_day_one_unless_he_changed_teams(self):
        agree = [('fanduel', 2.1, 1.75), ('betmgm', 2.1, 1.75)]
        new_season = '2026-10-25T00:30:00Z'
        stayed = history(points=(20,) * 20)  # All last season, with the Knicks.
        self.assertTrue(nb.evaluate(self.event(1.9, 1.9, agree, point=21.5, when=new_season), nb.History(stayed), {}, None, (1.6, 0.06)))
        # Moved from the Heat to the Knicks this season: one game with the Knicks is not enough yet.
        moved = history(points=(20,) * 20, team='Miami Heat') + [
            {**history(points=(20,))[0], 'date': '2026-10-21', 'game': 'new'}]
        self.assertEqual(nb.evaluate(self.event(1.9, 1.9, agree, point=21.5, when=new_season), nb.History(moved), {}, None, (1.6, 0.06)), [])

    def test_prop_parlays_settle_from_box_scores(self):
        leg = lambda player, side, point, event: {
            'event': event, 'sport': nb.SPORT, 'home': 'New York Knicks', 'away': 'Boston Celtics',
            'start': '2026-03-01T00:30:00Z', 'market': 'player_points', 'player': player, 'name': side, 'point': point,
            'price': 1.9, 'fair': 0.65, 'edge': 0.2}
        won = self.journal.add({'legs': [leg('Jalen Brunson', 'Under', 24.5, 'e1'), leg('Jayson Tatum', 'Over', 25.5, 'e2')],
                                'price': 3.61, 'hit': 0.42, 'ev': 0.5})
        void = self.journal.add({'legs': [leg('Jalen Brunson', 'Under', 24.5, 'e1'), leg('Not Playing', 'Over', 10.5, 'e2')],
                                 'price': 3.61, 'hit': 0.42, 'ev': 0.5})
        real = nba_data.games_on, nba_data.box
        nba_data.games_on = lambda day: [{'id': 'x', 'home': 'New York Knicks', 'away': 'Boston Celtics', 'final': True}]
        nba_data.box = lambda gid: [{'player': 'Jalen Brunson', 'pts': 22}, {'player': 'Jayson Tatum', 'pts': 30}]
        try:
            result = nb.run_settle(self.journal)
        finally:
            nba_data.games_on, nba_data.box = real
        self.assertEqual(result['settled'], 2)
        rows = {r['id']: r for r in self.journal.rows()}
        self.assertEqual((rows[won]['status'], rows[won]['payout']), ('won', round(10 * (1.9 * 1.9 - 1), 2)))
        self.assertEqual((rows[void]['status'], rows[void]['payout']), ('won', 9.0))  # The no-show's leg voids.

    def test_game_line_settling_leaves_prop_parlays_alone(self):
        p = {'legs': [{'event': 'e1', 'market': 'player_points', 'name': 'Over', 'point': 20.5, 'price': 1.9, 'player': 'X',
                       'home': 'H', 'away': 'A', 'sport': nb.SPORT, 'start': '2026-03-01T00:30:00Z', 'fair': 0.6, 'edge': 0.1}],
             'price': 1.9, 'hit': 0.6, 'ev': 0.1}
        self.journal.add(p)
        self.assertEqual(self.journal.settle({'e1': {'home_team': 'H', 'away_team': 'A', 'home': 100, 'away': 90}}), 0)


if __name__ == '__main__':
    unittest.main()
