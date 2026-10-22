"""Real Chrome fixture for buttons that appear briefly after another click
(Double Up after BUY): sequence clicks and let-the-first-click-through teaching.
Uses a local fake page only; no user sites."""
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

PAGE = '''<p>QT Demo USD 575.00</p>
<a href="https://promo.test/deposit-step-1?amount=2380">TRADE AND UPGRADE</a>
<input id="amt" aria-label="Amount" value="1" oninput="if(+this.value>575)this.value='575.00'">
<button id="buy" onclick="window.buys=(window.buys||0)+1;show()">BUY</button>
<div id="slot"></div>
<script>
function show(){
  const old=document.getElementById('double');if(old)old.remove();
  const b=document.createElement('button');b.id='double';b.setAttribute('aria-label','Double Up');b.textContent='x2';
  b.onclick=()=>{window.doubles=(window.doubles||0)+1};
  // Appears a moment after BUY and is gone again shortly after.
  setTimeout(()=>document.getElementById('slot').appendChild(b),400);
  setTimeout(()=>b.remove(),2500);
}
</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class BriefButtonTests(unittest.IsolatedAsyncioTestCase):
    async def test_sequence_click_and_pass_through_teaching(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://brief.test/trade')
                    runtime = Browser()
                    runtime._context, runtime._page = context, page
                    store = TargetStore(Path(directory) / 'targets.sqlite')
                    tools = {}

                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register

                    def save(image, name):
                        path = str(Path(directory) / (name + '.png'))
                        image.save(path)
                        return path

                    recall = register_target_tools(tool, runtime, save, lambda: None, store)
                    asked = []
                    with patch.object(browser_module, 'Browser', return_value=runtime),                             patch.object(browser_module, 'register_target_tools', return_value=recall),                             patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'procedures.sqlite')):
                        browser_module.register(tool, asked.append, save, lambda *args: '')

                    # 1. Sequence: Double Up is found by its label and clicked in time.
                    result = await tools['browser_click_sequence'](['BUY', 'Double Up'])
                    self.assertIn('BUY', result['clicked'])
                    self.assertIn('Double Up', result['clicked'])
                    self.assertEqual(await page.evaluate('[window.buys, window.doubles]'), [1, 1])
                    self.assertEqual(len(asked), 1)  # One approval for the whole sequence.

                    # A step that never appears fails clearly and says the first click happened.
                    with self.assertRaisesRegex(LookupError, 'did not appear.*after clicking'):
                        await tools['browser_click_sequence'](['BUY', 'Triple Up'], within_seconds=1)
                    self.assertEqual(await page.evaluate('window.buys'), 2)

                    # 2. Teaching: the owner's BUY click goes through, the next click marks Double Up.
                    await page.wait_for_selector('#double', state='detached', timeout=5000)
                    with self.assertRaises(ValueError):
                        await tools['browser_teach_start']('Chart', kind='region', selection='area', after_clicks=1)
                    await tools['browser_teach_start']('Double Up button', after_clicks=1)
                    self.assertEqual((await tools['browser_teach_status']())['clicks_to_let_through'], 1)
                    await page.locator('#buy').click()
                    self.assertEqual(await page.evaluate('window.buys'), 3)
                    await page.locator('#double').click()
                    status = await tools['browser_teach_status']()
                    self.assertEqual(status['status'], 'marked_not_confirmed')
                    self.assertEqual(status['captured_label'], 'Double Up')
                    self.assertEqual(await page.evaluate('window.doubles'), 1)  # Marking did not press it.
                    await page.get_by_text('Confirm taught target', exact=True).click()
                    # The button is gone by the time it is saved; it still saves.
                    await page.wait_for_selector('#double', state='detached', timeout=5000)
                    record = await tools['browser_teach_finish']()
                    self.assertIsNone(record['reference_image'])
                    self.assertEqual(record['descriptor']['attrs'], [['id', 'double'], ['aria-label', 'Double Up']])

                    # 3. The taught name drives a later sequence.
                    result = await tools['browser_click_sequence'](['BUY', 'Double Up button'])
                    self.assertEqual(await page.evaluate('[window.buys, window.doubles]'), [4, 2])

                    # 4. The 12:37 run: the stake is typed first, then the click repeats it. That click goes ahead.
                    await page.wait_for_selector('#double', state='detached', timeout=5000)
                    await runtime.snapshot(max_chars=0)
                    field = next(e['ref'] for e in runtime._refs.values() if e['name'] in ('Amount', '1'))
                    await tools['browser_type'](field, '15.00', submit=True)
                    self.assertEqual(await page.input_value('#amt'), '15.00')
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    await tools['browser_click'](buy, amount=15)
                    self.assertEqual(await page.evaluate('window.buys'), 5)
                    # The 17:01 run: a new stake passed with the click is put in the box, confirmed, then traded.
                    result = await tools['browser_click'](buy, amount=20)
                    self.assertEqual(await page.input_value('#amt'), '20')
                    self.assertEqual(await page.evaluate('window.buys'), 6)
                    # Searching "amount" finds the stake box, not the promo link with amount= in its address.
                    found = await tools['browser_find']('amount')
                    self.assertEqual(found['elements'][0]['ref'], field)
                    self.assertNotIn('TRADE AND UPGRADE', ' '.join(found['matches']))
                    # Typing into the promo link (what the 17:01 run kept doing) is refused: it leads to a deposit.
                    link = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'TRADE AND UPGRADE')
                    with self.assertRaisesRegex(PermissionError, 'moves money'):
                        await tools['browser_type'](link, '20.00', submit=True)

                    # 5. The 13:39 run: the site capped the entry at the whole balance. Typing reports it,
                    # and no trade button is clicked until the field shows the typed amount again.
                    with self.assertRaisesRegex(ValueError, 'field now shows "575.00", not 6060'):
                        await tools['browser_type'](field, '6060')
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    with self.assertRaisesRegex(ValueError, 'No click was made: the amount field shows "575.00", not the 6060'):
                        await tools['browser_click'](buy)
                    with self.assertRaisesRegex(ValueError, 'No click was made: the amount field shows'):
                        await tools['browser_click_sequence'](['BUY', 'Double Up'])
                    self.assertEqual(await page.evaluate('window.buys'), 6)
                    await runtime.snapshot(max_chars=0)
                    field = next(e['ref'] for e in runtime._refs.values() if e.get('tag') == 'input')
                    typed = await tools['browser_type'](field, '20')
                    self.assertEqual(typed['field_shows'], '20')
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    await tools['browser_click'](buy)
                    self.assertEqual(await page.evaluate('window.buys'), 7)

                    # 7. With two number boxes it does not guess: no click, and it says which boxes it saw.
                    await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<input id=other value=5>')")
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    with self.assertRaisesRegex(ValueError, 'could not tell which box is the amount field.*showing 5'):
                        await tools['browser_click'](buy, amount=30)
                    self.assertEqual(await page.evaluate('window.buys'), 7)
                    await page.evaluate("document.getElementById('other').remove()")

                    # 8. Pocket Option's layout: the stake box under an "Amount" label, plus the TOP UP form's
                    # amount box. The stake box is used and the deposit form's box is never touched.
                    await page.evaluate("""document.body.insertAdjacentHTML('beforeend',
                      '<div class="block block--bet-amount"><div class="block__title">Amount</div><div><input id="stake" value="2"></div></div>' +
                      '<div class="fast-deposit-modal"><form><div class="form-group js-amount-block"><input id="deposit" class="form-control" value="59"></div></form></div>')""")
                    await runtime.snapshot(max_chars=0)
                    buy = next(e['ref'] for e in runtime._refs.values() if e['name'] == 'BUY')
                    await tools['browser_click'](buy, amount=3)
                    self.assertEqual(await page.input_value('#stake'), '3')
                    self.assertEqual(await page.input_value('#deposit'), '59')
                    self.assertEqual(await page.evaluate('window.buys'), 8)
                    await page.evaluate("document.querySelector('.block--bet-amount').remove()")

                    # 6. Visual typing replaces the field: typing 60 onto 60 used to make "6060".
                    await page.fill('#amt', '60')
                    box = await page.locator('#amt').bounding_box()
                    point = f'{{"point": [{(box["x"] + box["width"] / 2) / 1000 * 1000:.0f}, {(box["y"] + box["height"] / 2) / 700 * 1000:.0f}]}}'
                    with patch.object(browser_module, 'Browser', return_value=runtime),                             patch.object(browser_module, 'register_target_tools', return_value=recall),                             patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory) / 'procedures2.sqlite')):
                        browser_module.register(tool, asked.append, save, lambda *args: point)
                    typed = await tools['browser_visual_type']('the amount field', '60')
                    self.assertEqual(await page.input_value('#amt'), '60')
                    self.assertEqual(typed['field_shows'], '60')
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
