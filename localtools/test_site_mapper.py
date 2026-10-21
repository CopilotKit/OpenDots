import unittest
from pathlib import Path
from unittest.mock import patch
import site_mapper


class SiteMapperTests(unittest.TestCase):
    def tools(self):
        found = {}
        def tool():
            def register(fn):
                found[fn.__name__] = fn
                return fn
            return register
        site_mapper.register(tool)
        return found

    def test_the_mapping_tools_are_registered(self):
        self.assertEqual(sorted(self.tools()), ['site_add', 'site_capture', 'site_inspect', 'site_list', 'site_verify'])

    def test_a_missing_build_says_where_to_look(self):
        with patch.object(site_mapper, 'CLI', Path('Z:/nowhere/cli.js')):
            with self.assertRaisesRegex(FileNotFoundError, 'SITE-MAPPING.md'):
                self.tools()['site_list']()

    def test_names_must_be_short_and_plain(self):
        with self.assertRaisesRegex(ValueError, 'short lowercase names'):
            self.tools()['site_add']('My Site!', 'search', 'https://x.test/?q={q}', {'q': 'a'})

    def test_examples_become_key_value_arguments(self):
        calls = []
        with patch.object(site_mapper, 'run', lambda *args: calls.append(args) or {'ok': True}):
            self.tools()['site_add']('books', 'search', 'https://x.test/?q={q}', {'q': 'dune'}, {'q': 'foundation'})
        self.assertEqual(calls[0], ('add', 'books', 'search', '--trigger', 'https://x.test/?q={q}',
                                    '--example', 'q=dune', '--example2', 'q=foundation'))

    def test_write_operations_can_be_captured_and_saved(self):
        calls = []
        with patch.object(site_mapper, 'run', lambda *args: calls.append(args) or {'ok': True}):
            tools = self.tools()
            tools['site_capture']('https://x.test/form', {'note': 'hi'}, write=True)
            tools['site_add']('notes', 'create', 'https://x.test/form', {'note': 'a'}, {'note': 'b'}, write=True)
            tools['site_capture']('https://x.test/form', {'note': 'hi'})
        self.assertIn('--write', calls[0])
        self.assertIn('--write', calls[1])
        self.assertNotIn('--write', calls[2])


if __name__ == '__main__':
    unittest.main()
