"""Real Chrome fixture for the stake limit (preservation); local page only."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from playwright.async_api import async_playwright
import browser as browser_module
from browser import Browser
from browser_targets import TargetStore, register_target_tools
from procedure_memory import ProcedureMemory

PAGE = '''<div class="balance-info-block__balance"><span class="js-balance-demo">50.00</span></div>
<input id="amt" value="1">
<button id="buy" onclick="window.buys=(window.buys||0)+1">BUY</button>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class StakeLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_stake_limit_tightens_below_start_and_blocks_everything_when_too_small(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'policy.json'
            policy.write_text(json.dumps({'stakeLimit': {'percent': 20, 'losingPercent': 10}}))
            start = Path(directory) / 'start.json'
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://stake.test/trade')
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

                    async def buy_ref():
                        await runtime.snapshot(max_chars=0)
                        return next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')

                    with patch.object(browser_module, 'POLICY_FILE', policy), patch.object(browser_module, 'STAKE_START_FILE', start):
                        buys = lambda: page.evaluate('window.buys || 0')
                        # 20% of $50 is $10: the 18:06 run's all-in stake is refused, the box is left alone.
                        with self.assertRaisesRegex(ValueError, r'No trade was placed: a \$50 stake is more than 20% of the \$50.00 balance\. Stake at most \$10.00'):
                            await tools['browser_click'](await buy_ref(), amount=50)
                        self.assertEqual(await page.input_value('#amt'), '1')
                        await tools['browser_click'](await buy_ref(), amount=10)
                        self.assertEqual(await buys(), 1)

                        # Below the run's $60 start the limit halves to 10%: $5.
                        start.write_text(json.dumps({'start': 60, 'updatedAt': time.time() * 1000}))
                        with self.assertRaisesRegex(ValueError, r"more than 10% .*below the run's \$60.00 start.*at most \$5.00"):
                            await tools['browser_click'](await buy_ref(), amount=10)
                        await tools['browser_click'](await buy_ref(), amount=5)
                        self.assertEqual(await buys(), 2)

                        # A big stake already sitting in the box is caught too, with no amount given.
                        await page.fill('#amt', '40')
                        # (The amount check sees the box changed since it was typed and refuses first.)
                        for attempt in (lambda: tools['browser_click'](ref), lambda: tools['browser_click_sequence'](['BUY', 'Double Up'])):
                            ref = await buy_ref()
                            with self.assertRaisesRegex(ValueError, r'a \$40 stake|amount field shows "40"'):
                                await attempt()
                        self.assertEqual(await buys(), 2)

                        # At $3.13 even $1 is too much: stop and report.
                        await page.evaluate("document.querySelector('.js-balance-demo').textContent = '3.13'")
                        with self.assertRaisesRegex(ValueError, r'at most \$0.31\. That is below the usual \$1 minimum: stop trading'):
                            await tools['browser_click'](await buy_ref(), amount=1)
                        self.assertEqual(await buys(), 2)

                    # Without a stakeLimit in the policy nothing changes.
                    policy.write_text(json.dumps({}))
                    with patch.object(browser_module, 'POLICY_FILE', policy), patch.object(browser_module, 'STAKE_START_FILE', start):
                        await tools['browser_click'](await buy_ref(), amount=1)
                        self.assertEqual(await buys(), 3)
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
