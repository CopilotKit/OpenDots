import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from site_maps import SiteMaps, migrate_sqlite, read_data


class TargetMemoryTests(unittest.TestCase):
    def test_targets_survive_restart_as_notes_per_site(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SiteMaps(Path(directory))
            store.save_target({'id': 'one', 'url': 'https://example.com/menu', 'context': 'https://example.com/menu',
                               'name': 'Menu', 'kind': 'button', 'descriptor': {'tag': 'button', 'label': 'Menu'}})
            restarted = SiteMaps(Path(directory))
            self.assertEqual(restarted.get_target('one', 'https://example.com/menu?secret=hidden')['name'], 'Menu')
            self.assertEqual(restarted.list_targets('https://different.example/menu'), [])
            note = Path(directory) / 'Example' / 'Targets' / 'Menu.md'
            self.assertTrue(note.exists())
            self.assertEqual(read_data(note)['page'], '/menu')
            overview = (Path(directory) / 'Example' / 'Example.md').read_text(encoding='utf-8')
            self.assertIn('[[Targets/Menu|Menu]]', overview)
            self.assertTrue(restarted.forget_target('one', 'https://example.com/menu'))
            self.assertFalse(restarted.forget_target('one', 'https://example.com/menu'))

    def test_pages_stay_separate_and_other_pages_are_a_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SiteMaps(Path(directory))
            demo = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/'
            live = 'https://pocketoption.com/en/cabinet/quick-high-low/USD/'
            store.save_target({'id': 'a', 'url': demo, 'context': demo, 'name': 'BUY', 'kind': 'button', 'descriptor': {'tag': 'a', 'label': 'Buy'}})
            store.save_target({'id': 'b', 'url': live, 'context': live, 'name': 'BUY', 'kind': 'button', 'descriptor': {'tag': 'a', 'label': 'BUY'}})
            store.save_target({'id': 'c', 'url': demo, 'context': demo, 'name': 'Double Up', 'kind': 'button', 'descriptor': {'tag': 'a', 'label': 'x2'}})
            self.assertEqual(store.get_target('BUY', live)['id'], 'b')
            self.assertEqual(store.get_target('BUY', demo)['id'], 'a')
            # Taught only on the demo page: offered on the live page, marked elsewhere.
            [double] = store.candidates('double up', live)
            self.assertTrue(double['elsewhere'])
            self.assertEqual(len(list((Path(directory) / 'Pocketoption' / 'Targets').glob('*.md'))), 3)

    def test_reteaching_keeps_the_old_layout_as_history(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SiteMaps(Path(directory))
            url = 'https://www.tradingview.com/chart/abc/'
            store.save_target({'id': 'old', 'url': url, 'name': 'Symbol search', 'kind': 'button', 'descriptor': {'tag': 'button', 'label': 'Old'}})
            store.save_target({'id': 'new', 'url': url, 'name': 'symbol_search', 'kind': 'button', 'descriptor': {'tag': 'button', 'label': 'New'}})
            [record] = store.site_targets(store.site_for(url))
            self.assertEqual(record['id'], 'old')
            self.assertEqual(record['descriptor']['label'], 'New')
            self.assertEqual(record['history'][0]['descriptor']['label'], 'Old')
            self.assertEqual(store.site_named('tradingview')['hosts'], ['tradingview.com'])

    def test_routines_are_notes_with_fill_ins(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SiteMaps(Path(directory))
            site = store.site_for('https://www.tradingview.com/chart/', create=True)
            store.save_routine(site, {'name': 'Open pair', 'params': ['pair'], 'steps': [
                {'do': 'click', 'target': 'Symbol search'}, {'do': 'type', 'target': 'Symbol input', 'text': '{pair}', 'submit': True}]})
            note = (Path(directory) / 'Tradingview' / 'Routines' / 'Open pair.md').read_text(encoding='utf-8')
            self.assertIn('Type `{pair}` into **Symbol input** and press Enter', note)
            self.assertEqual(store.routine(site, 'open_pair')['params'], ['pair'])
            renamed = store.rename_site('tradingview', 'TradingView')
            self.assertTrue((Path(directory) / 'TradingView' / 'TradingView.md').exists())
            self.assertEqual(store.routine(renamed, 'Open pair')['steps'][0]['target'], 'Symbol search')

    def test_old_sqlite_targets_are_copied_once(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / 'old.sqlite'
            db = sqlite3.connect(old)
            db.execute('CREATE TABLE browser_targets(id TEXT PRIMARY KEY, context TEXT NOT NULL, data TEXT NOT NULL)')
            record = {'id': 'x', 'context': 'https://pocketoption.com/en/cabinet/', 'name': 'Asset selector', 'kind': 'button', 'descriptor': {'tag': 'a', 'label': 'EUR/USD'}}
            db.execute('INSERT INTO browser_targets VALUES(?,?,?)', ('x', record['context'], json.dumps(record)))
            db.commit()
            db.close()
            store = SiteMaps(Path(directory) / 'maps')
            self.assertEqual(migrate_sqlite(store, old, []), 1)
            self.assertEqual(migrate_sqlite(store, old, []), 0)
            self.assertEqual(store.get_target('Asset selector', 'https://pocketoption.com/en/cabinet/')['id'], 'x')


if __name__ == '__main__':
    unittest.main()
