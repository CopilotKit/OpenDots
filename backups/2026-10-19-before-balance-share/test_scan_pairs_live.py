"""Real Chrome fixture for the pair scan: a copy of Pocket Option's asset list
(.alist__label rows with payouts, which stays open after a pick) and a local feed
that answers each pick with recent prices the way the site does. Local page only."""
import asyncio
import json
import math
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
from test_market_read_live import frame
from test_place_trade_live import PAGE, Server

PAIRS = [('AUD/CAD OTC', 92, 'down'), ('EUR/USD OTC', 92, 'flat'), ('GBP/JPY OTC', 92, 'up'),
         ('NZD/USD OTC', 85, 'flat'), ('EUR/USD', 88, 'up'), ('EUR/CAD', 92, 'frozen')]
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


def spike(count: int = 600) -> list:
    """Quiet prices, a short climb, then a big 5 s candle up that just closed: a fade (SELL)."""
    now = time.time()
    c0 = int(now // 5) * 5
    rows = []
    for i in range(count):
        t = c0 - count + i
        p = 1.0 + 0.0002 * math.sin(i / 2.0)
        if t >= c0 - 20:
            p = 1.0 + (t - (c0 - 20)) * 0.00008
        if t >= c0 - 5:
            p = 1.0012 + (t - (c0 - 5)) * 0.0006
        rows.append([t + 0.2, round(p, 6)])
    rows.append([now, rows[-1][1]])
    return rows


def prices(shape: str, count: int = 600) -> list:
    if shape == 'spike':
        return spike(count)
    now = time.time()
    out = []
    for i in range(count):
        j = i - (count - 158)
        if shape == 'turn':  # A long fall into RSI below 30, then a sharp turn up: an obvious BUY.
            p = (1.23 + 0.0004 * ((i % 3) - 1) if j < 0 else
                 1.23 - j * 0.0015 - (0.0006 if j % 11 == 0 else 0) if j < 150 else 1.005 + (j - 150) * 0.01)
        elif shape == 'flat':
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
                    # Keep test sessions out of the file the running OpenDots reads.
                    self.enterContext(patch.object(browser_module, 'TRADING_SESSION_FILE', Path(directory) / 'session.json'))
                    self.enterContext(patch.object(browser_module, 'FLAT_STAKE', 0))  # These tests check the stake levels.
                    self.enterContext(patch.object(browser_module, 'OBVIOUS_ONLY', False))  # ...and everyday trend trades.
                    self.enterContext(patch.object(browser_module, 'TRADING_MODE_FILE', Path(directory) / 'mode.json'))
                    self.enterContext(patch.object(browser_module, 'OTC_FADE', False))  # These trade OTC trends on purpose.

                    # The "site": each pick sends that pair's recent prices (candles first, large frame).
                    shapes = {name: shape for name, _, shape in PAIRS}

                    async def answer():
                        seen = 0
                        while True:
                            picks = await page.evaluate('window.assetPicks')
                            for name in picks[seen:]:
                                if shapes[name] == 'frozen':
                                    continue  # Listed at a top payout but sends no prices (seen late in the day).
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
                    # Only OTC pairs (the page is on an OTC pair) within 4 points of the best payout:
                    # NZD/USD at 85% is left out next to the 92% pairs.
                    self.assertEqual({r['pair'] for r in result['pairs']},
                                     {'AUD/CAD OTC', 'EUR/USD OTC', 'GBP/JPY OTC'})
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
                    self.assertEqual(len(saved['pairs']), 3)

                    # A scan of real (non-OTC) pairs reads only those, on 1-minute candles' scale.
                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        real = await tools['browser_scan_pairs'](count=4, market='real')
                    self.assertEqual(real['market'], 'real')
                    self.assertEqual([r['pair'] for r in real['pairs']], ['EUR/USD'])
                    self.assertEqual(real['candle_s'], 15)
                    self.assertEqual(real['now_on'], 'EUR/USD')
                    self.assertIn('1m or more', real['rules'])
                    self.assertEqual(real['no_prices'], ['EUR/CAD'])  # The frozen 92% pair is skipped.
                    # When even the best live pair pays under the minimum, the scan says so plainly.
                    with patch.object(browser_module, 'MIN_PAYOUT', 90), patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        low = await tools['browser_scan_pairs'](count=4, market='real')
                    self.assertIsNone(low['best'])
                    self.assertIn('Real pairs pay at most 88% right now, under the 90% minimum', low['note'])
                    # In obvious-only mode a 5-minute request still scans for 1-minute trades
                    # (15-second candles), where turns show up often enough to trade.
                    with patch.object(browser_module, 'OBVIOUS_ONLY', True), patch.object(browser_module, 'WATCH_SECONDS', 0),                             patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        quick = await tools['browser_scan_pairs'](count=4, market='real', expiry='5m')
                    self.assertEqual(quick['candle_s'], 15)
                    # The scanned market sets the rules: real pairs run 1 minute or more (also the default).
                    # "11m" is the OTC 11-second default carried over as minutes: real pairs get 1 minute.
                    result = await tools['browser_place_trade']('buy', 5, 'BUY: the OTC habit on a real pair', expiry='11m')
                    self.assertEqual((await page.evaluate('window.trades'))[-1], ['Buy', result['placed'].split()[1][1:], '00:01:00'])
                    self.assertIn('Expiry set to 1m', result['expiry_note'])
                    self.assertIn('for 60s on EUR/USD', result['placed'])
                    # Real-pair trades last minutes: with good confidence or better, another goes in
                    # beside the open one instead of waiting it out.
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM trades WHERE result IS NULL').fetchone()[0], 1)  # Still open.
                    db.close()
                    started = time.time()
                    second = await tools['browser_place_trade']('buy', reason='BUY: second real-pair trade')
                    self.assertIn(second['confidence'], ('good', 'very high', 'top'), second.get('chart_now'))
                    self.assertLess(time.time() - started, 10)
                    self.assertEqual(len(await page.evaluate('window.trades')), 2)

                    # Streak rule on real pairs: after a win on the pair the stake doubles; after a loss
                    # the pair is left (trades refused, scans skip it). The recovery stake is off.
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    with db:  # Close the open test trades, then record a win on EUR/USD.
                        db.execute("UPDATE trades SET result='tie', source='site' WHERE result IS NULL")
                        db.execute("INSERT INTO trades(id, asset, direction, stake, expiry_s, entry_ts, entry_price, setup, result, profit, source) "
                                   "VALUES ('won1', 'EURUSD', 'buy', 5, 60, ?, 1.0, '{}', 'win', 4.6, 'site')", (time.time(),))
                    db.close()
                    with patch.object(browser_module, 'FLAT_STAKE', 5.0):
                        doubled = await tools['browser_place_trade']('buy', reason='BUY: after a win here')
                    self.assertEqual((await page.evaluate('window.trades'))[-1][1], '10', doubled.get('stake_rule'))
                    self.assertIn('after a win on EUR/USD', doubled['stake_rule'])
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    with db:
                        db.execute("UPDATE trades SET result='tie', source='site' WHERE result IS NULL")
                        db.execute("INSERT INTO trades(id, asset, direction, stake, expiry_s, entry_ts, entry_price, setup, result, profit, source) "
                                   "VALUES ('lost1', 'EURUSD', 'buy', 10, 60, ?, 1.0, '{}', 'loss', -10, 'site')", (time.time() + 1,))
                    db.close()
                    with self.assertRaisesRegex(ValueError, 'the last trade on EUR/USD lost.*browser_scan_pairs'):
                        await tools['browser_place_trade']('buy', reason='BUY: right after a loss here')
                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        after_loss = await tools['browser_scan_pairs'](count=4, market='real')
                    self.assertEqual(after_loss['skipped_after_a_loss'], ['EUR/USD'])

                    # Obvious turns only: the scan stops at the first pair showing one and says so.
                    shapes['AUD/CAD OTC'] = 'turn'
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    with db:  # The real-pair test trades above would still be open: close them.
                        db.execute("UPDATE trades SET result='win', source='site' WHERE result IS NULL")
                    db.close()
                    await tools['browser_choose_asset']('EUR/USD OTC')
                    with patch.object(browser_module, 'OBVIOUS_ONLY', True), patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        sniper = await tools['browser_scan_pairs'](count=4, market='otc')
                    self.assertTrue(sniper['obvious'], sniper)
                    self.assertEqual([r['pair'] for r in sniper['pairs']], ['AUD/CAD OTC'])  # Stopped at the first.
                    self.assertEqual(sniper['now_on'], 'AUD/CAD OTC')
                    self.assertIn('green over red', sniper['best']['signal'])
                    self.assertEqual(await page.inner_text('a.current'), 'AUD/CAD OTC')
                    # ...and trades it itself, at once, in the signal's direction.
                    self.assertTrue(sniper['auto_trade']['placed'].startswith('BUY'), sniper['auto_trade'])
                    self.assertEqual((await page.evaluate('window.trades'))[-1][0], 'Buy')
                    self.assertIn('Traded it', sniper['note'])
                    # One trade per signal: a repeat on the same pair and direction is refused.
                    with patch.object(browser_module, 'OBVIOUS_ONLY', True):
                        with self.assertRaisesRegex(ValueError, 'already traded in the last 30 seconds'):
                            await tools['browser_place_trade']('buy', reason='BUY: the same turn again')

                    # Nothing obvious at first: the scan keeps watching the pairs it read (their
                    # prices keep streaming) and catches a turn that forms meanwhile.
                    shapes['AUD/CAD OTC'] = 'down'
                    reset = {'asset': 'AUDCAD_otc', 'period': 30, 'candles': [], 'history': prices('down')}
                    for writer in server.writers:  # Replace the turn it showed in the step above.
                        writer.write(frame(json.dumps(reset).encode()))
                        await writer.drain()
                    await asyncio.sleep(0.5)

                    async def turn_later():
                        await asyncio.sleep(6)
                        body = {'asset': 'EURUSD_otc', 'period': 30, 'candles': [], 'history': prices('turn')}
                        for writer in server.writers:
                            writer.write(frame(json.dumps(body).encode()))
                            await writer.drain()
                    later = asyncio.create_task(turn_later())
                    started = time.time()
                    with patch.object(browser_module, 'OBVIOUS_ONLY', True), patch.object(browser_module, 'WATCH_SECONDS', 30),                             patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        watched = await tools['browser_scan_pairs'](count=4, market='otc')
                    await later
                    self.assertTrue(watched['obvious'], watched)
                    self.assertEqual(watched['now_on'], 'EUR/USD OTC')
                    self.assertLess(time.time() - started, 25)  # Caught when it formed, not at the deadline.
                    # And with nothing forming, it reports none after the watch.
                    with patch.object(browser_module, 'OBVIOUS_ONLY', True), patch.object(browser_module, 'WATCH_SECONDS', 2),                             patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        shapes['EUR/USD OTC'] = 'flat'
                        quiet = await tools['browser_scan_pairs'](count=4, market='otc')
                    self.assertFalse(quiet['obvious'])
                    self.assertIn('No obvious setup on these pairs in the last 2 seconds', quiet['note'])
                    # Normal mode (switch off) takes obvious turns too: the scan stops on one and trades it.
                    turn = {'asset': 'GBPJPY_otc', 'period': 30, 'candles': [], 'history': prices('turn')}
                    shapes['GBP/JPY OTC'] = 'turn'
                    for writer in server.writers:
                        writer.write(frame(json.dumps(turn).encode()))
                        await writer.drain()
                    await asyncio.sleep(0.5)
                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file):
                        normal = await tools['browser_scan_pairs'](count=4, market='otc')
                    self.assertTrue(normal['obvious'], normal)
                    self.assertEqual(normal['now_on'], 'GBP/JPY OTC')
                    self.assertIn('auto_trade', normal)

                    # OTC fades: a stretched 5 s candle is traded against the move, for 30 s, by the
                    # scan itself; any other OTC trade is refused.
                    self.enterContext(patch.object(browser_module, 'OTC_FADE', True))
                    self.enterContext(patch.object(browser_module, 'FADE_FRESH', 10))  # Test timing, not the 3.5 s live window.
                    db = sqlite3.connect(Path(directory) / 'journal.sqlite')
                    with db:
                        db.execute("UPDATE trades SET result='win', source='site' WHERE result IS NULL")
                    db.close()
                    shapes['EUR/USD OTC'] = 'spike'
                    for name in ('AUD/CAD OTC', 'GBP/JPY OTC'):
                        shapes[name] = 'flat'
                    with patch.object(browser_module, 'PAIR_SCAN_FILE', scan_file), patch.object(browser_module, 'WATCH_SECONDS', 5):
                        faded = await tools['browser_scan_pairs'](count=4, market='otc')
                    self.assertEqual(faded['now_on'], 'EUR/USD OTC', faded)
                    self.assertTrue(faded['auto_trade']['placed'].startswith('SELL'), faded['auto_trade'])
                    self.assertEqual((await page.evaluate('window.trades'))[-1][::2], ['Sell', '00:00:08'])  # First fade: 8 s.
                    # The next fade takes 11 s (they alternate, for comparison).
                    await tools['browser_choose_asset']('AUD/CAD OTC')
                    shapes['AUD/CAD OTC'] = 'spike'
                    respike = {'asset': 'AUDCAD_otc', 'period': 30, 'candles': [], 'history': prices('spike')}
                    for writer in server.writers:
                        writer.write(frame(json.dumps(respike).encode()))
                        await writer.drain()
                    await asyncio.sleep(0.5)
                    second = await tools['browser_place_trade']('sell', reason='SELL: the second fade')
                    self.assertEqual((await page.evaluate('window.trades'))[-1][::2], ['Sell', '00:00:11'])
                    self.assertIn('for 11s', second['placed'])
                    self.assertIn('snaps back', faded['best']['signal'])
                    with self.assertRaisesRegex(ValueError, 'OTC trades only fade'):
                        await tools['browser_place_trade']('buy', reason='BUY: an OTC trend trade')
                    self.enterContext(patch.object(browser_module, 'OTC_FADE', False))

                    # Choosing a pair closes the list too.
                    picked = await tools['browser_choose_asset']('EUR/USD OTC')
                    self.assertTrue(picked['confirmed'])
                    self.assertEqual(await page.inner_text('a.current'), 'EUR/USD OTC')  # Not the real EUR/USD beside it.
                    self.assertEqual(await page.locator('.drop-down-modal-wrap').count(), 0)
                    # A fresh scan at least every few minutes: an old scan blocks the next trade.
                    await tools['browser_choose_asset']('GBP/JPY OTC')
                    with patch.object(browser_module, 'RESCAN_SECONDS', 0.5):
                        await asyncio.sleep(1)
                        with self.assertRaisesRegex(ValueError, 'the last scan was 0 minutes ago. Run browser_scan_pairs'):
                            await tools['browser_place_trade']('buy', reason='BUY: on an old scan')

                    # Only pairs from the latest scan trade: NZD/USD OTC (85%) was left out of it.
                    await tools['browser_choose_asset']('NZD/USD OTC')
                    with self.assertRaisesRegex(ValueError, 'NZD/USD OTC was not in the latest scan'):
                        await tools['browser_place_trade']('buy', 5, 'BUY: a pair outside the scan')
                finally:
                    if answering:
                        answering.cancel()
                    await chrome.close()
                    listener.close()


if __name__ == '__main__':
    unittest.main()
