"""Real Chrome fixture recreating the demo run: the model clicked [15] "Finance"
expecting "Buy", and the profile menu's overlay then covered BUY/SELL so every
click timed out. Local page only."""
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

PAGE = '''<style>.profile-menu__overlay{position:fixed;inset:0;display:none;z-index:10}</style>
<a href="#" id="finance" onclick="event.preventDefault();document.getElementById('ov').style.display='block'">Finance</a>
<button id="buy" style="margin:80px" onclick="window.buys=(window.buys||0)+1">BUY</button>
<button id="sell" onclick="window.sells=(window.sells||0)+1">SELL</button>
<div id="ov" class="profile-menu__overlay js-pm-overlay"></div>
<script>document.addEventListener('keydown', e => { if (e.key === 'Escape' && !window.stubborn) document.getElementById('ov').style.display = 'none'; });</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class ClickGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_wrong_ref_is_refused_and_overlays_are_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://guard.test/cabinet/demo-quick-high-low/')
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

                    async def ref(label):
                        await runtime.snapshot(max_chars=0)
                        return next(e['ref'] for e in runtime._refs.values() if e['name'] == label)

                    # The wrong ref, meant as "Buy": refused, with the real refs, and the menu stays closed.
                    buy, sell = await ref('BUY'), await ref('SELL')
                    with self.assertRaisesRegex(LookupError, rf'not the BUY or SELL button.*BUY is \[{buy}\], SELL is \[{sell}\]'):
                        await tools['browser_click'](await ref('Finance'), expected_text='Buy')
                    self.assertFalse(await page.is_visible('#ov'))

                    # A menu overlay left open is closed with Escape and the trade goes through.
                    await tools['browser_click'](await ref('Finance'))
                    self.assertTrue(await page.is_visible('#ov'))
                    await tools['browser_click'](await ref('BUY'), expected_text='Trade order placed')
                    self.assertEqual(await page.evaluate('window.buys'), 1)
                    self.assertFalse(await page.is_visible('#ov'))

                    # An overlay that Escape cannot close is named instead of a bare timeout.
                    await page.evaluate("window.stubborn = true; document.getElementById('ov').style.display = 'block'")
                    with self.assertRaisesRegex(LookupError, 'profile-menu__overlay.*is covering the button'):
                        await tools['browser_click'](await ref('SELL'))
                    self.assertIsNone(await page.evaluate('window.sells'))
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
