import unittest
from unittest.mock import AsyncMock, Mock
from browser import Browser


class TargetTests(unittest.IsolatedAsyncioTestCase):
    async def test_removed_cached_element_requires_rescan(self):
        browser = Browser()
        locator = Mock()
        locator.count = AsyncMock(return_value=0)
        page = Mock()
        page.locator.return_value.first = locator
        browser.page = AsyncMock(return_value=page)
        browser._refs[1] = {'tag': 'button', 'role': '', 'type': '', 'name': 'Menu'}
        with self.assertRaisesRegex(LookupError, 'no longer'):
            await browser.element(1)

    async def test_changed_label_is_not_accepted_from_cache(self):
        browser = Browser()
        previous = {'tag': 'button', 'role': '', 'type': '', 'name': 'Menu'}
        locator = Mock()
        locator.count = AsyncMock(return_value=1)
        locator.evaluate = AsyncMock(return_value={**previous, 'name': 'Delete'})
        page = Mock()
        page.locator.return_value.first = locator
        browser.page = AsyncMock(return_value=page)
        browser._refs[1] = previous
        with self.assertRaisesRegex(LookupError, 'changed'):
            await browser.element(1)
        locator.evaluate.return_value = previous.copy()
        info, _ = await browser.element(1)
        self.assertEqual(info['name'], 'Menu')


if __name__ == '__main__':
    unittest.main()
