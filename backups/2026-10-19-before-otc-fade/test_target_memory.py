import tempfile
import unittest
from pathlib import Path
from browser_targets import TargetStore


class TargetMemoryTests(unittest.TestCase):
    def test_targets_survive_restart_and_are_scoped_to_page(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'targets.sqlite'
            store = TargetStore(path)
            store.save_target({'id': 'one', 'context': 'https://example.com/menu', 'name': 'Menu', 'descriptor': {'tag': 'button'}})
            restarted = TargetStore(path)
            self.assertEqual(restarted.get_target('one', 'https://example.com/menu?secret=hidden')['name'], 'Menu')
            self.assertEqual(restarted.list_targets('https://different.example/menu'), [])
            with self.assertRaises(LookupError):
                restarted.get_target('one', 'https://example.com/other')
            self.assertTrue(restarted.forget_target('one', 'https://example.com/menu'))
            self.assertFalse(restarted.forget_target('one', 'https://example.com/menu'))
