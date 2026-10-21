import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
import browser
from procedure_memory import ProcedureMemory, page_context


class MemoryTests(unittest.TestCase):
    def test_versions_scope_persistence_and_unchecked_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'memory.sqlite'
            memory = ProcedureMemory(path)
            first = memory.begin('https://example.com/page?token=secret#section', 'Menu', 'Open menu')
            memory.append(first['id'], {'action': 'click', 'verification': 'passed'})
            self.assertEqual(memory.finish(first['id'])['status'], 'verified')
            second = memory.begin('https://example.com/page', 'Menu', 'Open menu')
            memory.append(second['id'], {'action': 'click', 'verification': 'unchecked'})
            self.assertEqual(memory.finish(second['id'])['status'], 'needs_review')
            restarted = ProcedureMemory(path)
            self.assertEqual(len(restarted.recall('https://example.com/page?other=1')), 2)
            self.assertEqual(restarted.recall('https://other.example/page'), [])
            self.assertEqual(restarted.recall('https://example.com/other'), [])
            self.assertEqual(page_context('https://user:pass@example.com/page?token=x'), 'https://example.com/page')
            self.assertTrue(restarted.delete(first['id']))
            self.assertEqual(len(restarted.recall('https://example.com/page')), 1)


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_tool_wrapper_records_transition_and_does_not_store_typed_values(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = ProcedureMemory(Path(directory) / 'memory.sqlite')
            page = Mock(url='https://example.com/menu?secret=hidden')
            visible = set()
            def by_text(text, exact):
                result = Mock()
                result.count = AsyncMock(return_value=int(text in visible))
                result.nth.return_value.is_visible = AsyncMock(return_value=text in visible)
                return result
            page.get_by_text.side_effect = by_text
            page.evaluate = AsyncMock(side_effect=lambda script: False if '__dotsTeach' in script else {'width': 1200, 'height': 800})
            locator = Mock()
            locator.scroll_into_view_if_needed = AsyncMock()
            locator.bounding_box = AsyncMock(return_value={'x': 10, 'y': 20, 'width': 60, 'height': 30})
            locator.click = AsyncMock(side_effect=lambda **kwargs: visible.add('Menu opened'))
            locator.fill = AsyncMock()
            locator.get_attribute = AsyncMock(return_value='Search')
            fake = Mock()
            fake.lock = asyncio.Lock()
            fake.page = AsyncMock(return_value=page)
            fake.element = AsyncMock(return_value=({'name': 'Menu', 'tag': 'button', 'role': '', 'type': 'search'}, locator))
            fake.highlight = AsyncMock()
            fake.settle = AsyncMock()
            fake.snapshot = AsyncMock(return_value={'url': page.url, 'elements': '[1] Menu'})
            tools = {}
            def tool():
                def register(fn):
                    tools[fn.__name__] = fn
                    return fn
                return register
            with patch.object(browser, 'Browser', return_value=fake), patch.object(browser, 'ProcedureMemory', return_value=memory), patch.object(browser, 'TAKEOVER_FLAG', Path(directory) / 'takeover'):
                browser.register(tool, lambda action: None, lambda image, name: 'image')
                version = await tools['browser_procedure_start']('Open menu', 'Menu visible')
                result = await tools['browser_click'](1, expected_text='Menu opened')
                self.assertEqual(result['procedure_memory']['verification'], 'passed')
                verified = await tools['browser_procedure_finish']()
                self.assertEqual(verified['status'], 'verified')
                version = await tools['browser_procedure_start']('Fill search', 'Search for a runtime value')
                await tools['browser_type'](1, 'PRIVATE INPUT VALUE')
                finished = await tools['browser_procedure_finish']()
                self.assertEqual(finished['status'], 'needs_review')
                self.assertEqual(verified['steps'][0]['target']['label'], 'Menu')
                self.assertNotIn('PRIVATE INPUT VALUE', str(memory.get(version['id'])))
                self.assertNotIn('secret=hidden', str(finished))
                locator.click.assert_awaited_once()
                recall = await tools['browser_procedure_recall']()
                self.assertEqual(len(recall['procedures']), 2)
                locator.click.assert_awaited_once()  # Recall never executes.
                await tools['browser_procedure_start']('Already open', 'Do not infer success')
                repeated = await tools['browser_click'](1, expected_text='Menu opened')
                self.assertEqual(repeated['procedure_memory']['verification'], 'failed')
                self.assertEqual((await tools['browser_procedure_finish']())['status'], 'needs_review')

    async def test_empty_recording_is_not_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = ProcedureMemory(Path(directory) / 'memory.sqlite')
            version = memory.begin('https://example.com', 'Empty', 'No action')
            self.assertEqual(memory.finish(version['id'])['status'], 'needs_review')


if __name__ == '__main__':
    unittest.main()
