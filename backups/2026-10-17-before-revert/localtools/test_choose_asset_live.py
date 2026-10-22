"""Real Chrome fixture for switching the traded asset from a scrolling list; local page only."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from playwright.async_api import async_playwright
import browser as browser_module
from browser import Browser
from browser_targets import TargetStore, register_target_tools
from procedure_memory import ProcedureMemory

PAIRS = [f'{a}/{b} OTC' for a in ('AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'NZD') for b in ('JPY', 'USD', 'CNY', 'SGD', 'TRY', 'ZAR', 'MXN', 'INR', 'BRL', 'HKD')]
PAGE = '''<style>
#list{display:none;position:absolute;top:60px;left:10px;width:300px;height:260px;overflow-y:auto;background:#eee}
#list.open{display:block} .row{height:32px;cursor:pointer} body{height:1600px}
</style>
<div class="tabs"><span class="tab" onclick="pick('AUD/CAD OTC')">AUD/CAD OTC <b>+58 %</b></span></div>
<a class="current" href="javascript:void 0" onclick="document.getElementById('list').classList.toggle('open')">EUR/USD OTC</a>
<div id="list">''' + ''.join(f'<div class="row" onclick="pick(\'{p}\')"><span>{p}</span> <b>+92%</b></div>' for p in PAIRS) + '''</div>
<div id="history"><div class="trade" onclick="window.opened=(window.opened||0)+1">GBP/JPY OTC</div></div>
<script>
function pick(p){document.querySelector('.current').textContent=p;document.getElementById('list').classList.remove('open');}
</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class ChooseAssetTests(unittest.IsolatedAsyncioTestCase):
    async def test_switches_asset_from_scrolling_list(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://assets.test/trade')
                    runtime = Browser()
                    runtime._context, runtime._page = context, page
                    tools = {}

                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register

                    save = lambda image, name: str(Path(directory) / (name + '.png'))
                    recall = register_target_tools(tool, runtime, save, lambda: None, TargetStore(Path(directory) / 't.sqlite'))
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')
                    current = lambda: page.locator('.current').text_content()

                    # Far down the list: needs scrolling. The trade-history entry is not clicked.
                    result = await tools['browser_choose_asset']('GBP/JPY OTC')
                    self.assertEqual(result['switched_to'], 'GBP/JPY OTC')
                    self.assertTrue(result['confirmed'])
                    self.assertEqual(await current(), 'GBP/JPY OTC')
                    self.assertIsNone(await page.evaluate('window.opened'))

                    # Name without OTC, near the end of the list.
                    await tools['browser_choose_asset']('NZD/HKD')
                    self.assertEqual(await current(), 'NZD/HKD OTC')

                    # A favourites tab is used directly.
                    await tools['browser_choose_asset']('AUD/CAD OTC')
                    self.assertEqual(await current(), 'AUD/CAD OTC')

                    # Unknown names fail clearly, list what is there, and change nothing.
                    with self.assertRaisesRegex(LookupError, 'not found in the asset list.*AUD/JPY OTC'):
                        await tools['browser_choose_asset']('XAU/XYZ OTC')
                    self.assertEqual(await current(), 'AUD/CAD OTC')
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
