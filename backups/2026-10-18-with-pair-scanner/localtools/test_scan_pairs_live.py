"""Real Chrome fixture for browser_scan_pairs: a local trading page whose server
sends a pair's recent price history when the chart switches to it, as Pocket
Option does. One pair trends up, one down, one is flat. Local page only."""
import asyncio
import base64
import hashlib
import json
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

CRLF = '\r\n'
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
TRENDS = {'GBPJPY_otc': 0.0002, 'AUDCAD_otc': -0.0002, 'EURGBP_otc': 0.0}
PAIRS = ['EUR/USD OTC', 'GBP/JPY OTC', 'AUD/CAD OTC', 'EUR/GBP OTC']


def history(asset):
    step = TRENDS.get(asset, 0.0)
    rows = [[1000 + i, 1 + i * step + (0.0004 if i % 7 == 0 else 0) + (0.001 if step == 0 and i % 2 else 0)] for i in range(600)]
    return json.dumps({'asset': asset, 'period': 30, 'history': rows}).encode()


def frame(payload: bytes) -> bytes:
    head = bytes([0x82])
    if len(payload) < 126:
        return head + bytes([len(payload)]) + payload
    if len(payload) < 65536:
        return head + bytes([126]) + len(payload).to_bytes(2, 'big') + payload
    return head + bytes([127]) + len(payload).to_bytes(8, 'big') + payload


class Server:
    def __init__(self):
        self.page = ''

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
        try:
            while True:  # The page asks for a pair's history with a short text message.
                b1, b2 = await reader.readexactly(2)
                size = b2 & 0x7F
                if size == 126:
                    size = int.from_bytes(await reader.readexactly(2), 'big')
                mask = await reader.readexactly(4)
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(await reader.readexactly(size)))
                if b1 & 0x0F != 1:
                    break  # Not a text message (the browser closing the socket).
                writer.write(frame(history(data.decode())))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass


PAGE = '''<style>#list{display:none;position:absolute;top:60px;left:10px;width:300px;height:200px;overflow-y:auto}#list.open{display:block}.row{height:32px;cursor:pointer}</style>
<p>QT Demo USD 120.00</p>
<a class="current" href="javascript:void 0" onclick="document.getElementById('list').classList.toggle('open')">EUR/USD OTC</a>
<div id="list">ROWS</div>
<div id="trades">Trades<br>Opened<br>Closed<br><span id="open">No opened trades</span></div>
<script>
const ws = new WebSocket('ws://127.0.0.1:PORT/feed'); ws.binaryType = 'arraybuffer'; ws.onopen = () => { window.ready = true; };
function pick(p) { document.querySelector('.current').textContent = p; document.getElementById('list').classList.remove('open');
  ws.send(p.replace(' OTC', '').replace('/', '') + '_otc'); }
</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class ScanPairsTests(unittest.IsolatedAsyncioTestCase):
    async def test_scans_in_the_trading_tab_and_stays_on_the_clearest_trend(self):
        server = Server()
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        rows = ''.join(f"<div class=\"row\" onclick='pick(\"{p}\")'><span>{p}</span> <b>+92%</b></div>" for p in PAIRS)
        server.page = PAGE.replace('PORT', str(port)).replace('ROWS', rows)
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
                            patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'p.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')
                    current = lambda: page.locator('.current').text_content()

                    # With a trade open, nothing is switched.
                    await page.evaluate("document.getElementById('open').textContent = 'GBP/JPY OTC +92%'")
                    with self.assertRaisesRegex(LookupError, 'A trade is still open'):
                        await tools['browser_scan_pairs'](PAIRS)
                    self.assertEqual(await current(), 'EUR/USD OTC')
                    await page.evaluate("document.getElementById('open').textContent = 'No opened trades'")

                    result = await tools['browser_scan_pairs'](PAIRS + ['USD/JPY OTC'], '15s')
                    self.assertEqual(result['pairs']['GBP/JPY OTC']['direction'], 'up')
                    self.assertEqual(result['pairs']['AUD/CAD OTC']['direction'], 'down')
                    self.assertEqual(result['pairs']['EUR/GBP OTC']['direction'], 'no clear trend')
                    self.assertEqual(result['pairs']['USD/JPY OTC']['direction'], 'not in the list')
                    self.assertIn(result['best']['pair'], ('GBP/JPY OTC', 'AUD/CAD OTC'))
                    self.assertEqual(result['now_on'], result['best']['pair'])
                    self.assertEqual(await current(), result['best']['pair'])
                    self.assertIn('clearest trends:', result['summary'])
                finally:
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
