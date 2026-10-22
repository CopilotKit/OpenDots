"""Real Chrome fixture for the price-feed chart reader and trade journal: a local
server serves a trading page and sends ticks over a WebSocket in Pocket Option's
frame format; local page only."""
import asyncio
import base64
import hashlib
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
from trading_feed import TradeJournal

CRLF = '\r\n'
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


class TickServer:
    """Serves the page and, on the same local address, a minimal WebSocket feed."""

    def __init__(self):
        self.writers = []
        self.page = ''

    async def handle(self, reader, writer):
        try:
            request = (await reader.readuntil((CRLF * 2).encode())).decode()
        except asyncio.IncompleteReadError:
            return  # A connection that closed without a request.
        if 'upgrade: websocket' not in request.lower():
            body = self.page.encode()
            head = CRLF.join(['HTTP/1.1 200 OK', 'Content-Type: text/html', f'Content-Length: {len(body)}', 'Connection: close', '', ''])
            writer.write(head.encode() + body)
            await writer.drain()
            writer.close()
            return
        key = next(line.split(':', 1)[1].strip() for line in request.split(CRLF) if line.lower().startswith('sec-websocket-key'))
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        head = CRLF.join(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', f'Sec-WebSocket-Accept: {accept}', '', ''])
        writer.write(head.encode())
        await writer.drain()
        self.writers.append(writer)

    async def send(self, ticks):
        for ts, price in ticks:
            payload = json.dumps([['EURUSD_otc', ts, price]]).encode()
            for writer in self.writers:
                writer.write(bytes([0x82, len(payload)]) + payload)  # Binary frame, short payload.
                await writer.drain()
            await asyncio.sleep(0.005)


PAGE = '''<a class="current" href="javascript:void 0">EUR/USD OTC</a>
<div class="block block--expiration-inputs"><div class="block__title">Time</div><div class="control__value"><div class="value__val">00:00:05</div></div></div>
<div class="block block--bet-amount"><div class="block__title">Amount</div><div><input id="stake" value="2"></div></div>
<button onclick="window.buys=(window.buys||0)+1">BUY</button>
<script>const ws = new WebSocket('ws://127.0.0.1:PORT/feed'); ws.binaryType = 'arraybuffer'; ws.onopen = () => { window.open_ = true; };</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class ChartReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_indicators_from_the_feed_and_journals_trades(self):
        server = TickServer()
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        server.page = PAGE.replace('PORT', str(port))
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.goto(f'http://127.0.0.1:{port}/trade')
                    await page.wait_for_function('window.open_ === true')
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
                    journal = TradeJournal(Path(directory) / 'journal.sqlite')
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'TradeJournal', return_value=journal), \
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')

                    # Before any prices: says so instead of guessing.
                    empty = await tools['browser_chart_read']('1s')
                    self.assertIn('No prices', empty.get('note', ''))

                    # 80 one-second ticks ending 30 s ago: rising with small dips.
                    base = time.time() - 110
                    await server.send([(base + i, 1.1 + i * 0.0002 - (0.0003 if i % 4 == 0 else 0)) for i in range(80)])
                    await asyncio.sleep(0.3)
                    chart = await tools['browser_chart_read']('1s')
                    self.assertEqual(chart['asset'], 'EURUSD_otc')
                    self.assertGreaterEqual(chart['candles'], 75)
                    self.assertGreater(chart['rsi14'], 50)
                    self.assertIn('macd_state', chart)
                    self.assertEqual(chart['ema9_slope'], 'up')
                    self.assertEqual(chart['your_record']['all'], 'no trades yet')

                    # A BUY is journaled with its setup, then settles from later prices.
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    await tools['browser_click'](buy)
                    trades = (await tools['browser_trade_journal']())['trades']
                    self.assertEqual(len(trades), 1)
                    self.assertEqual((trades[0]['direction'], trades[0]['expiry_s'], trades[0]['stake'], trades[0]['result']), ('buy', 5, 2.0, 'open'))
                    self.assertEqual(trades[0]['setup']['candle_s'], 1)
                    await server.send([(base + 80 + i, 1.2 + i * 0.001) for i in range(10)])
                    await asyncio.sleep(0.3)
                    after = await tools['browser_trade_journal']()
                    self.assertEqual(after['trades'][0]['result'], 'win')
                    self.assertEqual(after['record']['all'], '1 won of 1')
                    self.assertEqual((await tools['browser_chart_read']('1s'))['your_record']['all'], '1 won of 1')
                finally:
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
