import unittest
from browser_geometry import viewport_point


class GeometryTests(unittest.TestCase):
    def test_normalized_point_uses_css_viewport_not_screenshot_pixels(self):
        # A 2880x1800 high-DPI screenshot still represents a 1440x900 viewport.
        self.assertEqual(viewport_point('{"point":[500,250]}', 1440, 900), (720, 225))
        self.assertEqual(viewport_point('{"point":[1000,1000]}', 1440, 900), (1439, 899))

    def test_rejects_unrelated_numbers_and_invalid_points(self):
        for answer in ['There are 12 buttons and 3 menus.', '{"point":[-1,20]}', '{"point":[1001,20]}', '{"point":[true,20]}', '{"point":[NaN,20]}', '{"point":[20]}']:
            self.assertIsNone(viewport_point(answer, 1440, 900))

    def test_accepts_json_fences_and_ignores_reasoning_numbers(self):
        self.assertEqual(viewport_point('<think>12 buttons</think>```json\n{"point":[500,500]}\n```', 1000, 800), (500, 400))


if __name__ == '__main__':
    unittest.main()
