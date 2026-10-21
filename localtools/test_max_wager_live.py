"""Real Chrome fixture: no max wager. The 08:05 run left the stake box at the
whole $119.16 balance and traded all-in from the first click. Local page only."""
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

PAGE = '''<a href="https://pocketoption.test/en/cabinet/deposit-step-1?amount=2380" onclick="event.preventDefault();window.bad=1">TRADE AND UPGRADE receive an 80% promo code</a>
<div class="balance-info-block__balance"><span class="js-balance-demo">119.16</span></div>
<div class="block block--bet-amount"><div class="block__title">Amount</div><div><input id="stake" value="119.16"></div></div>
<button onclick="window.buys=(window.buys||0)+1">BUY</button>
<button onclick="window.sells=(window.sells||0)+1">SELL</button>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class MaxWagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_whole_balance_stakes_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://wager.test/cabinet/demo-quick-high-low/')
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
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')

                    async def ref(label):
                        await runtime.snapshot(max_chars=0)
                        return next(e['ref'] for e in runtime._refs.values() if e['name'] == label)

                    for label in ('BUY', 'SELL'):
                        with self.assertRaisesRegex(ValueError, r'stake box shows \$119.16, which is your whole balance\. Your balance on the page right now is \$119.16.*max wager.*such as 23.83'):
                            await tools['browser_click'](await ref(label))
                    self.assertEqual(await page.evaluate('[window.buys, window.sells]'), [None, None])

                    # A stake typed into the promo link (the 13:28 run did this nine times) goes into the Amount box.
                    typed = await tools['browser_type'](await ref('TRADE AND UPGRADE receive an 80% promo code'), '9.31', submit=True)
                    self.assertEqual(await page.input_value('#stake'), '9.31')
                    self.assertEqual((typed['typed_into'], typed['field_now_shows']), ('Amount box', '9.31'))
                    self.assertIn('is not a text box', typed['note'])
                    self.assertIsNone(await page.evaluate('window.bad'))

                    # A smaller stake trades normally.
                    await tools['browser_type'](await ref('9.31'), '20')
                    await tools['browser_click'](await ref('BUY'))
                    self.assertEqual(await page.evaluate('window.buys'), 1)
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
