"""Real Chrome fixture for place_trade on a copy of Pocket Option's trading panel
(a.btn-call / a.btn-put, the Amount box, the Time picker, the balance) with a
local price feed. Local page only."""
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


class Server:
    def __init__(self):
        self.page = ''
        self.writers = []

    async def handle(self, reader, writer):
        try:
            request = (await reader.readuntil((CRLF * 2).encode())).decode()
        except asyncio.IncompleteReadError:
            return
        if 'upgrade: websocket' not in request.lower():
            body = self.page.encode()
            writer.write(CRLF.join(['HTTP/1.1 200 OK', 'Content-Type: text/html', f'Content-Length: {len(body)}', 'Connection: close', '', '']).encode() + body)
            await writer.drain()
            writer.close()
            return
        key = next(l.split(':', 1)[1].strip() for l in request.split(CRLF) if l.lower().startswith('sec-websocket-key'))
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        writer.write(CRLF.join(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', f'Sec-WebSocket-Accept: {accept}', '', '']).encode())
        await writer.drain()
        self.writers.append(writer)

    async def send(self, ticks):
        for ts, price in ticks:
            payload = json.dumps([['EURUSD_otc', ts, price]]).encode()
            for writer in self.writers:
                writer.write(bytes([0x82, len(payload)]) + payload)
                await writer.drain()
            await asyncio.sleep(0.003)


PAGE = '''<a class="current" href="javascript:void 0">EUR/USD OTC</a>
<div class="balance-info-block__balance"><span class="js-balance-demo">119.16</span></div>
<div class="block block--expiration-inputs"><div class="block__title">Time</div>
 <div class="block__control control"><div class="control__value value" onclick="toggle()"><div class="value__val">00:01:00</div></div></div></div>
<div class="drop-down-modal trading-panel-modal expiration-inputs-list-modal" style="display:none">
 <div class="rw"><input type="text" value="00"></div><div class="rw"><input type="text" value="01"></div><div class="rw"><input type="text" value="00"></div></div>
<div class="block block--bet-amount"><div class="block__title">Amount</div><div><input id="stake" value="5"
 oninput="if (+this.value > 119.16) this.value = '119.16'"></div></div>
<a class="btn btn-call" onclick="placed('Buy')">BUY</a> <a class="btn btn-put" onclick="placed('Sell')">SELL</a>
<div id="log"></div>
<script>
const ws = new WebSocket('ws://127.0.0.1:PORT/feed'); ws.binaryType = 'arraybuffer'; ws.onopen = () => { window.ready = true; };
const panel = document.querySelector('.expiration-inputs-list-modal'), shown = document.querySelector('.value__val');
const boxes = [...panel.querySelectorAll('input')], pad = n => String(n).padStart(2, '0');
function toggle() { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; }
boxes.forEach(b => b.addEventListener('change', () => { shown.textContent = boxes.map(x => pad(+x.value)).join(':'); }));
function placed(side) { window.trades = (window.trades || []).concat([[side, document.getElementById('stake').value, shown.textContent]]);
  document.getElementById('log').insertAdjacentHTML('beforeend', '<p>Trade order placed EUR/USD OTC Forecast ' + side + '</p>'); }
</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class PlaceTradeTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_call_sets_stake_and_time_and_clicks_the_real_button(self):
        server = Server()
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        server.page = PAGE.replace('PORT', str(port))
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
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
                    with patch.object(browser_module, 'Browser', return_value=runtime), \
                            patch.object(browser_module, 'register_target_tools', return_value=recall), \
                            patch.object(browser_module, 'TradeJournal', return_value=TradeJournal(Path(directory) / 'journal.sqlite')),                             patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')
                    trades = lambda: page.evaluate('window.trades || []')

                    # Bad inputs and a max wager place nothing.
                    with self.assertRaisesRegex(ValueError, 'direction must be'):
                        await tools['browser_place_trade']('maybe', 10)
                    with self.assertRaisesRegex(ValueError, r'whole balance \(\$119.16 on the page\).*max wager'):
                        await tools['browser_place_trade']('buy', 119.16)
                    self.assertEqual(await trades(), [])

                    # First trade: the feed starts with it, so the reading may still be warming up.
                    result = await tools['browser_place_trade']('buy', 12)
                    self.assertEqual(await trades(), [['Buy', '12', '00:00:11']])
                    self.assertEqual((result['placed'], result['confirmed']), ('BUY $12 for 11s on EUR/USD OTC', True))

                    # With rising prices the chart reads "up": a SELL against it is refused, a BUY goes through.
                    base = time.time() - 600
                    await server.send([(base + i, 1.1 + i * 0.00002 - (0.00003 if i % 4 == 0 else 0)) for i in range(400)])
                    await asyncio.sleep(0.3)
                    with self.assertRaisesRegex(ValueError, r'chart reads up right now \(RSI .*a SELL goes against it'):
                        await tools['browser_place_trade']('sell', 7.5)
                    self.assertEqual(len(await trades()), 1)
                    result = await tools['browser_place_trade']('buy', '7.50')
                    self.assertEqual((await trades())[-1], ['Buy', '7.5', '00:00:11'])
                    reading = result['chart_now']
                    self.assertEqual(reading['asset'], 'EURUSD_otc')
                    self.assertIsNotNone(reading['rsi14'])
                    self.assertEqual(result['balance_now'], 119.16)
                    self.assertEqual(result['your_record']['all'], 'no trades yet')

                    # Later prices settle that BUY as a win, and the next trade reports it.
                    await server.send([(base + 400 + i, 1.2 + i * 0.0001) for i in range(30)])
                    await asyncio.sleep(0.3)
                    result = await tools['browser_place_trade']('buy', 5)
                    self.assertEqual(result['your_record']['all'], '1 won of 1')
                    self.assertIn('buy_in_this_setup', result['your_record'])
                finally:
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
