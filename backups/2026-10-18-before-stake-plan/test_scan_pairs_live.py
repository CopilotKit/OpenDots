"""Real Chrome fixture for the pair scan: a copy of Pocket Option's asset list
(.alist__label rows with payouts, which stays open after a pick) and a local feed
that answers each pick with recent prices the way the site does. Local page only."""
import asyncio
import json
import math
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
from trading_feed import TradeJournal
from test_market_read_live import frame
from test_place_trade_live import PAGE, Server

PAIRS = [('AUD/CAD OTC', 92, 'down'), ('EUR/USD OTC', 92, 'flat'), ('GBP/JPY OTC', 92, 'up'),
         ('NZD/USD OTC', 85, 'flat'), ('EUR/USD', 88, 'up')]
LIST = '''<div id="modal-root"></div>
<script>
const current = document.querySelector('a.current');
window.assetPicks = [];
const rows = PAIRS.map(([name, payout]) => '<div class="alist__item"><span class="alist__label">' + name +
  '</span><span class="alist__payout">+' + payout + '%</span></div>').join('');
current.onclick = () => { document.getElementById('modal-root').innerHTML = '<div class="drop-down-modal-wrap"><div class="assets-block">' + rows + '</div></div>';
  document.querySelectorAll('.alist__label').forEach(e => e.onclick = () => { current.textContent = e.textContent; window.assetPicks.push(e.textContent); }); };
// Like the real site: a pick leaves the list open; a click elsewhere closes it.
document.addEventListener('click', e => { if (!e.target.closest('.drop-down-modal-wrap, a.current')) document.getElementById('modal-root').innerHTML = ''; });
</script>'''.replace('PAIRS', json.dumps([[n, p] for n, p, _ in PAIRS]))


def prices(shape: str, count: int = 600) -> list:
    now = time.time()
    out = []
    for i in range(count):
        if shape == 'flat':
            p = 1.0 + 0.0004 * math.sin(i / 3)
        else:
            sign = 1 if shape == 'up' else -1
            p = 1.0 + sign * (i * 0.00002 + (i ** 2) * 2e-7) - sign * (0.00003 if i % 7 == 0 else 0)
        out.append([round(now - (count - i), 3), round(p, 6)])
    return out


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class ScanPairsTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_rates_pairs_and_ends_on_the_clearest_trend(self):
        server = Server()
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        server.page = PAGE.replace('PORT', str(port)) + LIST
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                answering = None
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.goto(f'http://127.0.0.1:{port}/cabinet/demo-quick-high-low/')
                    await page.wait_for_function('window.ready === true')
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
                    scan_file = Path(directory) / 'pair-scan.json'
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'TradeJournal', return_value=TradeJournal(Path(directory) / 'journal.sqlite')), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')

                    # The "site": each pick sends that pair's recent prices (candles first, large frame).
                    shapes = {name: shape for name, _, shape in PAIRS}

                    async def answer():
                        seen = 0
                        while True:
                            picks = await page.evaluate('window.assetPicks')
                            for name in picks[seen:]:
                                asset = name.replace('/', '').replace(' OTC', '_otc')
                                body = {'candles': [], 'asset': asset, 'period': 30, 'history': prices(shapes[name])}
                                for writer in server.writers:
                                    writer.write(frame(json.dumps(body).encode()))
                                    await writer.drain()
                            seen = len(picks)
                            await asyncio.sleep(0.05)
                    answering = asyncio.create_task(answer())

                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        result = await tools['browser_scan_pairs'](count=4)
                    # Only OTC pairs (the page is on an OTC pair), highest payout first: NZD/USD (85%) is 4th.
                    self.assertEqual({r['pair'] for r in result['pairs']},
                                     {'AUD/CAD OTC', 'EUR/USD OTC', 'GBP/JPY OTC', 'NZD/USD OTC'})
                    trends = {r['pair']: r['trend'] for r in result['pairs']}
                    self.assertEqual((trends['GBP/JPY OTC'], trends['AUD/CAD OTC'], trends['EUR/USD OTC']), ('up', 'down', 'no clear trend'))
                    # Ends on the clearest trend, with the list closed so the trade controls are free.
                    self.assertIn(result['best']['pair'], ('GBP/JPY OTC', 'AUD/CAD OTC'))
                    self.assertEqual(result['now_on'], result['best']['pair'])
                    self.assertEqual(await page.inner_text('a.current'), result['best']['pair'])
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 0)
                    self.assertEqual(result['pairs'][0], result['best'])
                    self.assertIn('trade', result['note'])
                    saved = json.loads(scan_file.read_text(encoding='utf-8'))
                    self.assertEqual(saved['now_on'], result['now_on'])
                    self.assertEqual(len(saved['pairs']), 4)

                    # A scan of real (non-OTC) pairs reads only those, on 1-minute candles' scale.
                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        real = await tools['browser_scan_pairs'](count=4, market='real')
                    self.assertEqual(real['market'], 'real')
                    self.assertEqual([r['pair'] for r in real['pairs']], ['EUR/USD'])
                    self.assertEqual(real['candle_s'], 15)
                    self.assertEqual(real['now_on'], 'EUR/USD')
                    self.assertIn('1m or more', real['rules'])
                    # The scanned market sets the rules: real pairs default to 1 minute and refuse less.
                    with self.assertRaisesRegex(ValueError, 'needs an expiry of 1m or more'):
                        await tools['browser_place_trade']('buy', 5, 'BUY: too short for a real pair', expiry='30s')
                    result = await tools['browser_place_trade']('buy', 5, 'BUY: EUR/USD trending up, no major news')
                    self.assertEqual((await page.evaluate('window.trades'))[-1], ['Buy', '5', '00:01:00'])
                    self.assertIn('for 60s on EUR/USD', result['placed'])

                    # Choosing a pair closes the list too.
                    picked = await tools['browser_choose_asset']('EUR/USD OTC')
                    self.assertTrue(picked['confirmed'])
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 0)
                    # Only the scanned market's pairs trade: the session is on real pairs now.
                    with self.assertRaisesRegex(ValueError, 'this session trades real pairs'):
                        await tools['browser_place_trade']('buy', 5, 'BUY: OTC pair in a real session')
                finally:
                    if answering:
                        answering.cancel()
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
