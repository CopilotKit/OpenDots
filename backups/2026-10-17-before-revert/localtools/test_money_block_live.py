"""Real Chrome fixture for the money block and trade-target check, recreating the
21:14 run: a TOP UP form with "Continue and pay $4.54", a promo link to the
deposit page, POCKET FRIENDS, and BUY. Local page only."""
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
<a href="/en/cabinet/pocket-friends" onclick="event.preventDefault();window.bad=(window.bad||0)+1">POCKET FRIENDS</a>
<a class="h-btn h-btn--deposit" onclick="window.bad=(window.bad||0)+1;document.querySelector('.fast-deposit-modal').style.display='block'">TOP UP</a>
<div class="block block--bet-amount"><div class="block__title">Amount</div><div><input id="stake" value="2"></div></div>
<button id="buy" onclick="window.buys=(window.buys||0)+1">BUY</button>
<div class="fast-deposit-modal" style="display:block"><form><div class="form-group js-amount-block"><input id="deposit" class="form-control" value="100"></div>
<button type="button" onclick="window.bad=(window.bad||0)+1">Continue and pay $4.54</button>
<button type="button" onclick="window.bad=(window.bad||0)+1">Apply</button></form></div>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class MoneyBlockTests(unittest.IsolatedAsyncioTestCase):
    async def test_money_controls_are_refused_and_stakes_only_go_to_trade_buttons(self):
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

                    asked = []
                    save = lambda image, name: str(Path(directory) / (name + '.png'))
                    recall = register_target_tools(tool, runtime, save, lambda: None, TargetStore(Path(directory) / 't.sqlite'))
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        # Confirmations always pass, as in unattended mode.
                        browser_module.register(tool, asked.append, save, lambda *args: '')

                    async def ref(label):
                        await runtime.snapshot(max_chars=0)
                        return next(e['ref'] for e in runtime._refs.values() if (e['name'] or '').startswith(label))

                    bad = lambda: page.evaluate('window.bad || 0')
                    # Money controls: refused even though every confirmation would pass.
                    for label in ('Continue and pay', 'TOP UP', 'TRADE AND UPGRADE', 'Apply'):
                        with self.assertRaisesRegex(PermissionError, 'moves money'):
                            await tools['browser_click'](await ref(label))
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_type'](await ref('100'), '4.54')
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_open']('https://pocketoption.com/en/cabinet/deposit-step-1?amount=2380')
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_click_sequence'](['BUY', 'TOP UP'])
                    self.assertEqual(await bad(), 0)
                    self.assertEqual(await page.input_value('#deposit'), '100')

                    # A stake sent to a non-trade button (the stale-ref clicks) is refused.
                    with self.assertRaisesRegex(LookupError, 'not a BUY or SELL button'):
                        await tools['browser_click'](await ref('POCKET FRIENDS'), amount=2.42)
                    self.assertEqual(await bad(), 0)

                    # The real trade still works.
                    await tools['browser_click'](await ref('BUY'), amount=3)
                    self.assertEqual((await page.evaluate('window.buys'), await page.input_value('#stake')), (1, '3'))

                    # Look-and-click aimed at "Buy" that lands on TOP UP or POCKET FRIENDS is refused.
                    for label, error in (('TOP UP', PermissionError), ('POCKET FRIENDS', LookupError)):
                        box = await page.get_by_text(label, exact=True).bounding_box()
                        point = f'{{"point": [{(box["x"] + box["width"] / 2) / 1000 * 1000:.0f}, {(box["y"] + box["height"] / 2) / 700 * 1000:.0f}]}}'
                        with patch.object(browser_module, 'Browser', return_value=runtime), \
                                patch.object(browser_module, 'register_target_tools', return_value=recall), \
                                patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p2.sqlite')):
                            browser_module.register(tool, asked.append, save, lambda *args, point=point: point)
                        with self.assertRaises(error):
                            await tools['browser_visual_click']('the main Buy button')
                    self.assertEqual(await bad(), 0)
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
