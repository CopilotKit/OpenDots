"""Real Chrome fixture for place_trade on a copy of Pocket Option's trading panel
(a.btn-call / a.btn-put, the Amount box, the Time picker, the balance) with a
local price feed. Local page only."""
import asyncio
import base64
import hashlib
import json
import os
import sqlite3
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
import trading_feed

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
 <div class="rw"><input type="text" value="00"></div><div class="rw"><input type="text" value="01"></div><div class="rw"><input type="text" value="00"></div>
 <div class="presets"><a class="preset">S15</a> <a class="preset">S30</a> <a class="preset">M1</a></div></div>
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
// Like the site's boxes: Ctrl+A selects nothing and each digit overwrites the one at the caret.
boxes.forEach(b => b.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); return; }
  if (!/^[0-9]$/.test(e.key)) return;
  e.preventDefault();
  const at = Math.min(b.selectionStart ?? 0, 1), digits = (b.value + '00').slice(0, 2).split('');
  digits[at] = e.key; b.value = digits.join(''); b.setSelectionRange(at + 1, at + 1);
}));
document.querySelectorAll('.preset').forEach(a => a.onclick = () => {
  const s = {S15: 15, S30: 30, M1: 60}[a.textContent];
  [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].forEach((v, i) => { boxes[i].value = pad(v); });
  shown.textContent = boxes.map(x => pad(+x.value)).join(':');
});
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
                    # Keep test sessions out of the file the running OpenDots reads.
                    self.enterContext(patch.object(browser_module, 'TRADING_SESSION_FILE', Path(directory) / 'session.json'))
                    trades = lambda: page.evaluate('window.trades || []')
                    set_balance = lambda value: page.evaluate(f"document.querySelector('.js-balance-demo').textContent = '{value}'")

                    # Bad inputs and a max wager place nothing.
                    with self.assertRaisesRegex(ValueError, 'direction must be'):
                        await tools['browser_place_trade']('maybe', 10, 'test')
                    with self.assertRaisesRegex(ValueError, r'whole balance \(\$119.16 on the page\).*max wager'):
                        await tools['browser_place_trade']('buy', 119.16, 'test')
                    self.assertEqual(await trades(), [])

                    # First trade: the feed starts with it, so the reading may still be warming up.
                    with self.assertRaisesRegex(ValueError, 'Give a one-line reason'):
                        await tools['browser_place_trade']('buy', 12)
                    # No profit yet and normal confidence (the feed is still warming up): code stakes $1.
                    result = await tools['browser_place_trade']('buy', 12, 'BUY: first test trade')
                    self.assertEqual(await trades(), [['Buy', '1', '00:00:11']])
                    self.assertEqual((result['placed'], result['confirmed']), ('BUY $1 for 11s on EUR/USD OTC', True))
                    self.assertEqual(result['stake_note'], 'You asked for $12; the stake rule chose $1.')
                    self.assertIn('early stake $1', result['stake_rule'])
                    # The result carries the trade facts, not a dump of the whole page.
                    self.assertNotIn('elements', result)
                    self.assertNotIn('text', result)
                    self.assertLess(len(json.dumps(result)), 1200)

                    # With rising prices the chart reads "up": a SELL against it is refused, a BUY goes through.
                    base = time.time() - 600
                    await server.send([(base + i, 1.1 + (i ** 2) * 1e-7 - (0.00001 if i % 7 == 0 else 0)) for i in range(400)])  # Accelerating rise.
                    await asyncio.sleep(0.3)
                    with self.assertRaisesRegex(ValueError, r'chart reads up right now \(RSI .*a SELL goes against it'):
                        await tools['browser_place_trade']('sell', 7.5, 'SELL: against the trend on purpose')
                    self.assertEqual(len(await trades()), 1)
                    # $20 of profit on the page: the $5 floor plus a share of the profit by confidence.
                    await set_balance('139.16')
                    result = await tools['browser_place_trade']('buy', '7.50', 'BUY: RSI rising, MACD bullish, candles mostly green')
                    self.assertEqual((await trades())[-1], ['Buy', result['placed'].split()[1][1:], '00:00:11'])
                    self.assertIn(result['placed'].split()[1][1:], ('5', '8.75', '12.5'))
                    self.assertIn('profit pot $20', result['stake_rule'])
                    reading = result['chart_now']
                    self.assertEqual(reading['asset'], 'EURUSD_otc')
                    self.assertIsNotNone(reading['rsi14'])
                    self.assertEqual(result['balance_now'], 139.16)
                    self.assertEqual(result['your_record']['all'], 'no trades yet')

                    # Later prices settle that BUY as a win, and the next trade reports it.
                    await server.send([(base + 400 + i, 1.2 + i * 0.001) for i in range(30)])
                    await asyncio.sleep(0.3)
                    result = await tools['browser_place_trade']('buy', 5, 'BUY: trend still up', expiry='1m')
                    self.assertEqual(result['your_record']['all'], '1 won of 1')
                    self.assertEqual(result['previous_trade']['result'], 'WON')  # The closed trade's result comes back.
                    self.assertIn('buy_in_this_setup', result['your_record'])
                    # OTC trades run 30 seconds at most: a 1-minute request becomes 30s, on 5-second candles.
                    self.assertEqual((await trades())[-1], ['Buy', result['placed'].split()[1][1:], '00:00:30'])
                    self.assertEqual(result['candle_s'], 5)
                    self.assertIn('shortened from 60s to 30s', result['expiry_note'])
                    # (Set with the panel's S30 button.) The next 11s trade below starts from 00:00:30:
                    # the case from a live run, where typing over it gave 31 instead of 11.

                    # The journal: reasons kept, summary by market/expiry, and a CSV export.
                    journal = await tools['browser_trade_journal']()
                    self.assertEqual(journal['summary']['all'], '1 won of 1 (100%)')
                    self.assertIn('OTC', journal['summary']['market'])
                    reasons = [r['setup'].get('reason') for r in journal['recent']]
                    self.assertIn('BUY: RSI rising, MACD bullish, candles mostly green', reasons)
                    self.assertTrue(Path(journal['csv']).exists())

                    # One trade at a time: with the 1-minute trade open and no profit to back a
                    # second one, the next call waits for it to close (here the feed reaches its
                    # expiry a second later), reports the result, and only then places the trade.
                    await set_balance('119.16')
                    async def later():
                        await asyncio.sleep(1)
                        # A long fall into RSI below 30, then a sharp turn up: MACD crosses green over red,
                        # a reversal, the highest-confidence BUY.
                        # (One message, so the waiting trade sees the whole move at once.)
                        rows = [['EURUSD_otc', base + 430 + i, (1.23 - i * 0.0015 - (0.0006 if i % 11 == 0 else 0)) if i < 150
                                 else (1.005 + (i - 150) * 0.01)] for i in range(158)]
                        payload = json.dumps(rows).encode()
                        for writer in server.writers:
                            writer.write(bytes([0x82, 126]) + len(payload).to_bytes(2, 'big') + payload)
                            await writer.drain()
                    feeding = asyncio.create_task(later())
                    started = time.time()
                    result = await tools['browser_place_trade']('buy', 6, 'BUY: after the 1m trade')
                    await feeding
                    self.assertGreater(time.time() - started, 0.9)
                    self.assertRegex(result['previous_trade']['trade'], r'^BUY \$[0-9.]+ for 30s$')
                    self.assertIn(result['previous_trade']['result'], ('WON', 'LOST'))  # Prices fell after it.
                    self.assertEqual((await trades())[-1], ['Buy', result['placed'].split()[1][1:], '00:00:11'])
                    # Very high confidence (RSI far above 50, all agreeing) and profit to cover it:
                    # a second trade goes in at once while the first is still open.
                    await set_balance('139.16')
                    started = time.time()
                    result = await tools['browser_place_trade']('buy', 7, 'BUY: strong trend, second trade')
                    self.assertEqual(result['confidence'], 'very high', result.get('chart_now'))
                    self.assertIn('green over red', result['chart_now']['signal']['why'])
                    self.assertEqual(result['chart_now']['signal']['kind'], 'reversal')
                    self.assertLess(time.time() - started, 6)
                    self.assertEqual((await trades())[-1], ['Buy', result['placed'].split()[1][1:], '00:00:11'])
                    self.assertEqual(result['placed'].split()[1][1:], '12.5')  # Very high: $5 + 50% of the $15 above the floor.
                    self.assertNotIn('previous_trade', result)
                    # Without a stake code picks it the same way, with no note.
                    await set_balance('119.16')
                    await asyncio.sleep(12)  # Let the open trades end (their 5-second grace passes too).
                    result = await tools['browser_place_trade']('buy', reason='BUY: no stake given')
                    self.assertEqual((await trades())[-1], ['Buy', result['placed'].split()[1][1:], '00:00:11'])
                    self.assertNotIn('stake_note', result)
                    self.assertIn('early stake', result['stake_rule'])

                    # A top setup (MACD cross + RSI beyond 30 + the band curving up, stood in for here)
                    # stakes $10 outside the usual levels and runs 5 seconds on OTC.
                    await asyncio.sleep(12)
                    top = {'direction': 'up', 'kind': 'reversal', 'why': 'MACD crossed bullish (green over red), with RSI below 30'}
                    with patch.object(trading_feed, 'reversal_signal', lambda closes, **k: dict(top)),                             patch.object(trading_feed, 'band_turn', lambda bars, **k: {'direction': 'up', 'why': 'band curving up'}):
                        result = await tools['browser_place_trade']('buy', 3, 'BUY: top setup', expiry='11s')
                    self.assertEqual(result['confidence'], 'top')
                    self.assertEqual((await trades())[-1], ['Buy', '10', '00:00:05'])
                    self.assertIn('top setup', result['stake_rule'])
                    self.assertIn('5s for a top setup', result['expiry_note'])

                    # Pocket Option reports the close itself ({"profit", "deals"}): that result is the
                    # one recorded, whatever the ticks suggested.
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    trade_id, opened = db.execute('SELECT id, entry_ts FROM trades WHERE stake = 10 ORDER BY rowid DESC LIMIT 1').fetchone()
                    db.close()
                    close = {'profit': -10, 'deals': [{'id': 'deal-1', 'openTimestamp': round(opened), 'closeTimestamp': round(opened) + 5,
                                                       'amount': 10, 'profit': -10, 'openPrice': 1.0, 'closePrice': 0.99,
                                                       'command': 0, 'asset': 'EURUSD_otc', 'isDemo': 1}]}
                    payload = json.dumps(close).encode()
                    for writer in server.writers:
                        writer.write(bytes([0x82, 126]) + len(payload).to_bytes(2, 'big') + payload)
                        await writer.drain()
                    await asyncio.sleep(0.5)
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    self.assertEqual(db.execute('SELECT result, profit, source, deal_id FROM trades WHERE id=?', (trade_id,)).fetchone(),
                                     ('loss', -10.0, 'site', 'deal-1'))
                    db.close()

                    # Three losses in a row: the next trade is refused until a new scan.
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    with db:
                        for i in range(3):
                            db.execute("INSERT INTO trades(id, asset, direction, stake, expiry_s, entry_ts, entry_price, setup, result, exit_price) "
                                       "VALUES (?, 'EURUSD_otc', 'buy', 1, 11, ?, 1.0, '{}', 'loss', 0.9)", (f'loss{i}', time.time() + 10000 + i))
                    await asyncio.sleep(12)
                    with self.assertRaisesRegex(ValueError, '3 losses in a row since the last scan.*browser_scan_pairs'):
                        await tools['browser_place_trade']('buy', reason='BUY: after three losses')
                    with db:
                        db.execute("DELETE FROM trades WHERE id LIKE 'loss%'")
                    db.close()

                    # The trailing stop is switched off for now: a peak of $300 locks nothing, stakes come
                    # from the whole profit, and falling back toward the start does not stop trading.
                    await asyncio.sleep(12)
                    await set_balance('300')
                    result = await tools['browser_place_trade']('buy', reason='BUY: at the peak')
                    self.assertNotIn('locked', result['stake_rule'])
                    session = json.loads((Path(directory) / 'session.json').read_text(encoding='utf-8'))
                    self.assertEqual((session['start'], session['peak'], session['locked']), (119.16, 300.0, None))
                    await asyncio.sleep(12)
                    await set_balance('209.9')
                    result = await tools['browser_place_trade']('buy', reason='BUY: after the drop')
                    self.assertTrue(result['confirmed'])  # No trailing stop: trading goes on.
                finally:
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
