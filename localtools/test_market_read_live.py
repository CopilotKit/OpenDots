"""Real Chrome fixture for the big-picture reading: a copy of Pocket Option's
chart timeframe button and panel, and a local feed that answers a timeframe
pick with ready-made candles the way the site does. Local page only."""
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
from test_place_trade_live import PAGE, Server

PERIODS = {'M1': 60, 'M5': 300, 'H1': 3600}
CHART = '''<a class="items__link items__link--chart-type" onclick="openPanel()"><span class="counter__icon">S30</span></a>
<div id="modal-root"></div>
<script>
const label = document.querySelector('.items__link--chart-type .counter__icon');
window.picks = [];
function closePanel() { document.getElementById('modal-root').innerHTML = ''; }
function openPanel() {
  document.getElementById('modal-root').innerHTML = '<div class="drop-down-modal-wrap">' +
    ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15','M30','H1','H4','D1']
      .map(t => '<a class="item" onclick="pick(this.textContent)">' + t + '</a>').join('') + '</div>';
}
function pick(t) { label.textContent = t; window.picks.push(t); }
// Like the real site: picking and Escape leave the panel open; a click elsewhere closes it.
document.addEventListener('click', e => { if (!e.target.closest('.drop-down-modal-wrap, .items__link--chart-type')) closePanel(); });
</script>'''


def frame(payload: bytes) -> bytes:
    if len(payload) < 126:
        return bytes([0x82, len(payload)]) + payload
    return bytes([0x82, 126]) + len(payload).to_bytes(2, 'big') + payload


def rows(period: int, rising: bool, count: int = 100) -> list:
    """Candles [time, open, close, high, low, ticks], newest first, ending now."""
    end = int(time.time() // period * period)
    out, price = [], 1.1
    for i in range(count):
        step = (i ** 2) * 2e-7 * (1 if rising else -1) - (0.00002 if i % 7 == 0 else 0) * (1 if rising else -1)
        close = round(1.1 + step, 6)
        out.append([end - (count - 1 - i) * period, price, close, max(price, close) + 0.00001, min(price, close) - 0.00001, 50])
        price = close
    return out[::-1]


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class MarketReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeframe_candles_give_the_big_picture_and_the_chart_is_put_back(self):
        server = Server()
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        server.page = PAGE.replace('PORT', str(port)) + CHART
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                answering = None
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.goto(f'http://127.0.0.1:{port}/cabinet/demo-quick-high-low/')
                    await page.wait_for_function('window.ready === true')
                    # Longer trades are for real (non-OTC) pairs; OTC trades stop at 30 seconds.
                    await page.evaluate("document.querySelector('a.current').textContent = 'EUR/USD'")
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
                            patch.object(browser_module, 'TradeJournal', return_value=TradeJournal(Path(directory) / 'journal.sqlite')), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')
                    # Keep test sessions out of the file the running OpenDots reads.
                    self.enterContext(patch.object(browser_module, 'TRADING_SESSION_FILE', Path(directory) / 'session.json'))

                    # The "site": answer each timeframe pick with candles (candles first, as a
                    # large frame, so the reader cannot rely on key order or frame size).
                    async def answer():
                        seen = 0
                        while True:
                            picks = await page.evaluate('window.picks')
                            for name in picks[seen:]:
                                if name in PERIODS:
                                    body = {'candles': rows(PERIODS[name], rising=True), 'asset': 'EURUSD',
                                            'period': PERIODS[name], 'history': []}
                                    for writer in server.writers:
                                        writer.write(frame(json.dumps(body).encode()))
                                        await writer.drain()
                            seen = len(picks)
                            await asyncio.sleep(0.05)
                    answering = asyncio.create_task(answer())

                    reading = await tools['browser_market_read']('M5')
                    self.assertEqual((reading['timeframe'], reading['candles'], reading['trend']), ('M5', 100, 'up'))
                    self.assertTrue(math.isclose(reading['covers_hours'], 100 * 300 / 3600, rel_tol=0.01))
                    self.assertEqual(await page.evaluate('window.picks'), ['M5', 'S30'])  # Put back afterwards.
                    self.assertEqual(await page.inner_text('.counter__icon'), 'S30')
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 0)

                    # Fresh candles are reused without touching the chart again.
                    await tools['browser_market_read']('5m')
                    self.assertEqual(len(await page.evaluate('window.picks')), 2)
                    with self.assertRaisesRegex(ValueError, 'timeframe must be like'):
                        await tools['browser_market_read']('soon')

                    # A 5-minute trade reads 1-minute candles: the bigger picture is up, so a
                    # SELL is refused and a BUY goes through with the reading attached.
                    with self.assertRaisesRegex(ValueError, r'chart reads up right now.*a SELL goes against it'):
                        await tools['browser_place_trade']('sell', 5, 'SELL: testing the big-picture rule', expiry='5m')
                    self.assertEqual(await page.evaluate('window.trades || []'), [])
                    result = await tools['browser_place_trade']('buy', 5, 'BUY: M1 trend up', expiry='5m')
                    self.assertEqual(await page.evaluate('window.trades'), [['Buy', result['placed'].split()[1][1:], '00:05:00']])
                    self.assertEqual((result['big_picture']['timeframe'], result['big_picture']['trend']), ('M1', 'up'))
                    self.assertEqual(await page.inner_text('.counter__icon'), 'S30')
                    # A panel left open (by the owner or an earlier step) is closed before trading.
                    await page.click('.items__link--chart-type')
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 1)
                    # Short trades keep the quick tick reading and leave the chart alone.
                    picks = len(await page.evaluate('window.picks'))
                    result = await tools['browser_place_trade']('buy', 5, 'BUY: short test trade')
                    self.assertNotIn('big_picture', result)
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 0)
                    self.assertEqual(len(await page.evaluate('window.picks')), picks)
                finally:
                    if answering:
                        answering.cancel()
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
