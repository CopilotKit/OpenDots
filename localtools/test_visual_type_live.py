"""Real Chrome fixture: look-and-type replaces the stake box instead of appending
(the 23:02 run typed 24.99 onto 49.98 and the site kept ~50). Local page only."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from playwright.async_api import async_playwright
import browser as browser_module
from browser import Browser
from browser_targets import register_target_tools
from site_maps import SiteMaps
from procedure_memory import ProcedureMemory

# The box caps entries at the balance, as Pocket Option does.
PAGE = '''<div style="padding:40px"><input id="stake" value="49.98" style="width:200px;height:40px"
 oninput="if (+this.value > 49.98 || isNaN(+this.value)) this.value = '49.98'"></div>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class VisualTypeTests(unittest.IsolatedAsyncioTestCase):
    async def test_look_and_type_replaces_the_box(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://stake.test/trade')
                    box = await page.locator('#stake').bounding_box()
                    point = f'{{"point": [{(box["x"] + box["width"] / 2) / 1000 * 1000:.0f}, {(box["y"] + box["height"] / 2) / 700 * 1000:.0f}]}}'
                    runtime = Browser()
                    runtime._context, runtime._page = context, page
                    tools = {}

                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register

                    save = lambda image, name: str(Path(directory) / (name + '.png'))
                    recall = register_target_tools(tool, runtime, save, lambda: None, SiteMaps(Path(directory) / 'maps'))
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: point)

                    result = await tools['browser_visual_type']('the amount input field', '24.99', submit=True)
                    self.assertEqual(await page.input_value('#stake'), '24.99')
                    self.assertEqual(result['field_now_shows'], '24.99')
                    await tools['browser_visual_type']('the amount input field', '10')
                    self.assertEqual(await page.input_value('#stake'), '10')
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
