import unittest

import numpy as np

import spread_hold_lab as L


def spread(mids, lefts, width=5.0):
    mid = np.array([mids], float)
    return {'mid': mid, 'left': np.array([lefts]), 'credit': mid[:, 0] - L.SLIP, 'width': width}


class ExitRules(unittest.TestCase):
    def test_held_to_expiry_settles_at_intrinsic_without_slippage(self):
        b = spread([1.0, 0.6, 0.2, 0.0], [14, 7, 3, 0])
        assert np.isclose(L.exits(b, None, None, 0)[0], (0.98 - 0.0) * 100 - 2 * L.FEE)

    def test_target_buys_back_first_close_at_half(self):
        b = spread([1.0, 0.6, 0.45, 0.0], [14, 7, 3, 0])
        assert np.isclose(L.exits(b, 0.5, None, 0)[0], (0.98 - 0.47) * 100 - 4 * L.FEE)

    def test_deadline_and_stop(self):
        b = spread([1.0, 1.5, 2.5, 5.0], [21, 14, 7, 0])
        assert np.isclose(L.exits(b, None, None, 14)[0], (0.98 - 1.52) * 100 - 4 * L.FEE)
        assert np.isclose(L.exits(b, None, 2.0, 0)[0], (0.98 - 2.52) * 100 - 4 * L.FEE)

    def test_dead_columns_after_expiry_are_ignored(self):
        b = spread([1.0, 0.3, np.nan], [7, 0, -1])
        assert np.isclose(L.exits(b, 0.5, 3.0, 3)[0], (0.98 - 0.3) * 100 - 2 * L.FEE)


if __name__ == '__main__':
    unittest.main()
