import unittest

import numpy as np

import algo_lab as al


def row(day, time, y, **c):
    return {'day': day, 'y': y, 'side': c.pop('side', 'put'), 'dte': c.pop('dte', 2), 'delta': c.pop('delta', 0.15),
            'c': {'time': time, 'vix_vs_20d': 0.0, 'ma20_z': 0.0, **c}, 'x': [0.0] * 15}


class PickTests(unittest.TestCase):
    def test_one_trade_a_day_the_earliest_accepted_or_the_best_scored(self):
        rows = [row('2026-01-05', 630, 5.0), row('2026-01-05', 570, -20.0), row('2026-01-06', 570, 8.0)]
        self.assertEqual(sorted(al.first_each_day(rows, lambda r: True)), [('2026-01-05', -20.0), ('2026-01-06', 8.0)])
        scores = lambda rs: np.array([r['y'] for r in rs])  # A perfect score.
        self.assertEqual(sorted(al.best_each_day(rows, scores, 0.0)), [('2026-01-05', 5.0), ('2026-01-06', 8.0)])
        self.assertEqual(al.best_each_day(rows, scores, 6.0), [('2026-01-06', 8.0)])

    def test_the_rules_take_only_their_conditions(self):
        rows = [row('2026-01-05', 570, 9.0, vix_vs_20d=-0.10),            # Fear fading: a put rule day.
                row('2026-01-06', 570, 9.0, vix_vs_20d=0.05),             # Fear rising: no.
                row('2026-01-07', 570, 7.0, side='call', dte=5, delta=0.20, ma20_z=2.0)]  # Stretched: a call day.
        self.assertEqual(sorted(d for d, _ in al.rules([])(rows)), ['2026-01-05', '2026-01-07'])


class TreeTests(unittest.TestCase):
    def test_the_tree_finds_the_split_that_matters(self):
        rng = np.random.default_rng(0)
        X = rng.normal(size=(2000, 3))
        y = np.where(X[:, 1] > 0.5, 10.0, -5.0) + rng.normal(0, 1, 2000)
        model = al.Tree(depth=2, leaf=100).fit(X, y)
        self.assertEqual(model.node[0], 1)  # Split on the feature that drives the result.
        self.assertGreater(model.predict(np.array([[0, 2.0, 0]]))[0], 8)
        self.assertLess(model.predict(np.array([[0, -2.0, 0]]))[0], -3)


if __name__ == '__main__':
    unittest.main()
