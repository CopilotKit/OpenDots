"""Opt-in real Chromium test; the fixture is intercepted locally, never sent online."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import browser
from procedure_memory import ProcedureMemory


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chromium test')
class LiveProcedureTest(unittest.IsolatedAsyncioTestCase):
    async def test_relearns_menu_positions_using_live_dom(self):
        from playwright.async_api import async_playwright
        with tempfile.TemporaryDirectory() as directory:
            memory = ProcedureMemory(Path(directory) / 'memory.sqlite')
            async with async_playwright() as playwright:
                chrome = await playwright.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700}, device_scale_factor=2)
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(content_type='text/html', body='''<button id="menu" onclick="document.querySelector('#actions').hidden=false">Open menu</button><section id="actions" hidden><span>Actions</span><button onclick="document.querySelector('#ready').hidden=false">Configure</button></section><p id="ready" hidden>Settings ready</p>'''))
                    runtime = browser.Browser()
                    runtime._context, runtime._page = context, page
                    tools = {}
                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register
                    with patch.object(browser, 'Browser', return_value=runtime), patch.object(browser, 'ProcedureMemory', return_value=memory), patch.object(browser, 'TAKEOVER_FLAG', Path(directory) / 'takeover'):
                        browser.register(tool, lambda action: None, lambda image, name: 'unused')
                        versions = []
                        for offset in (10, 400):
                            await page.goto('http://procedure.test/menu')
                            await page.locator('#menu').evaluate('(element, x) => { element.style.marginLeft = x + "px"; }', offset)
                            await tools['browser_procedure_start']('Open settings', 'Menu then settings panel')
                            for label, expected in [('Open menu', 'Actions'), ('Configure', 'Settings ready')]:
                                found = await tools['browser_find'](label)
                                ref = found['elements'][0]['ref']
                                result = await tools['browser_click'](ref, expected_text=expected)
                                self.assertEqual(result['procedure_memory']['verification'], 'passed')
                            version = await tools['browser_procedure_finish']()
                            self.assertEqual(version['status'], 'verified')
                            versions.append(version)
                        self.assertNotEqual(versions[0]['steps'][0]['target']['bounds_hint']['x'], versions[1]['steps'][0]['target']['bounds_hint']['x'])
                        self.assertEqual(len((await tools['browser_procedure_recall']())['procedures']), 2)
                finally:
                    await chrome.close()
