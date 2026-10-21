import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import browser
from procedure_memory import ProcedureMemory


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Isolated browser regression')
class VisualGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_blank_noneditable_and_reloaded_page_do_not_receive_actions(self):
        from playwright.async_api import async_playwright
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width':1000,'height':700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body='<button onclick="window.clicks=(window.clicks||0)+1">Menu</button>', content_type='text/html'))
                    runtime = browser.Browser()
                    runtime._context, runtime._page = context, page
                    tools = {}
                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register
                    delay = [0]
                    point = [0,0]
                    def vision(*args):
                        time.sleep(delay[0])
                        return json.dumps({'point':point})
                    with patch.object(browser, 'Browser', return_value=runtime), patch.object(browser, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory)/'memory.sqlite')), patch.object(browser, 'TAKEOVER_FLAG', Path(directory)/'takeover'):
                        browser.register(tool, lambda action: None, lambda *args:'fixture.png', vision)
                        with self.assertRaisesRegex(LookupError, 'No active website'):
                            await tools['browser_visual_click']('Menu')
                        await page.goto('http://guards.test/')
                        point[:]=[800,800] # background
                        with self.assertRaisesRegex(LookupError, 'non-interactive'):
                            await tools['browser_visual_click']('Menu')
                        box=await page.locator('button').bounding_box()
                        point[:]=[(box['x']+box['width']/2), (box['y']+box['height']/2)/700*1000]
                        with self.assertRaisesRegex(LookupError, 'editable'):
                            await tools['browser_visual_type']('Menu', 'must not type')
                        delay[0]=0.5
                        async def reload():
                            await asyncio.sleep(0.2)
                            await page.reload()
                        pending=asyncio.create_task(reload())
                        with self.assertRaisesRegex(LookupError, 'navigated or reloaded'):
                            await tools['browser_visual_click']('Menu')
                        await pending
                        self.assertEqual(await page.evaluate('window.clicks||0'),0)
                finally:
                    await chrome.close()
