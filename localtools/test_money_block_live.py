"""Real Chrome fixture for the money block, recreating the 21:14 run's TOP UP
form ("Continue and pay $4.54") and promo link to the deposit page; local page only."""
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

PAGE = '''<a href="https://pocketoption.test/en/cabinet/deposit-step-1?amount=2380" onclick="event.preventDefault();window.bad=(window.bad||0)+1">TRADE AND UPGRADE receive an 80% promo code</a>
<a class="h-btn h-btn--deposit" onclick="window.bad=(window.bad||0)+1">TOP UP</a>
<input id="stake" value="2">
<button id="buy" onclick="window.buys=(window.buys||0)+1">BUY</button>
<div class="fast-deposit-modal"><form><div class="form-group js-amount-block"><input id="deposit" class="form-control" value="100"></div>
<button type="button" onclick="window.bad=(window.bad||0)+1">Continue and pay $4.54</button>
<button type="button" onclick="window.bad=(window.bad||0)+1">Apply</button></form></div>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class MoneyBlockTests(unittest.IsolatedAsyncioTestCase):
    async def test_money_controls_are_refused_even_when_confirmations_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://money.test/cabinet/demo-quick-high-low/')
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
                        # Confirmations always pass, as in unattended mode.
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')

                    async def ref(label):
                        await runtime.snapshot(max_chars=0)
                        return next(e['ref'] for e in runtime._refs.values() if (e['name'] or '').startswith(label))

                    for label in ('Continue and pay', 'TOP UP', 'TRADE AND UPGRADE', 'Apply'):
                        with self.assertRaisesRegex(PermissionError, 'moves money'):
                            await tools['browser_click'](await ref(label))
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_type'](await ref('100'), '4.54')
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_open']('https://pocketoption.com/en/cabinet/deposit-step-1?amount=2380')
                    self.assertEqual(await page.evaluate('window.bad || 0'), 0)
                    self.assertEqual(await page.input_value('#deposit'), '100')

                    # Trading itself is unchanged.
                    await tools['browser_type'](await ref('2'), '3')
                    await tools['browser_click'](await ref('BUY'))
                    self.assertEqual((await page.evaluate('window.buys'), await page.input_value('#stake')), (1, '3'))
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
