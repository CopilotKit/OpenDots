"""Real Chrome fixture: saving, running and recording routines on a mapped site."""
import os
import tempfile
import unittest
from pathlib import Path
from playwright.async_api import async_playwright
from browser import Browser
from browser_targets import register_target_tools
from site_maps import SiteMaps

PAGE = '''<button id="search" onclick="document.getElementById('box').style.display='block'">Symbol search</button>
<div id="box" style="display:none"><input id="symbol" aria-label="Symbol" placeholder="Symbol"
 onkeydown="if(event.key==='Enter'){document.getElementById('shown').textContent='Chart: '+this.value;this.parentElement.style.display='none'}"></div>
<p id="shown">Chart: none</p><button id="review" onmouseover="window.hovered=true" onclick="document.getElementById('shown').textContent='ORDER PLACED'">Review Order</button><script>addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement===document.body){e.preventDefault();document.getElementById('box').style.display='block';document.getElementById('symbol').focus();}})</script><button id="alert" onclick="document.getElementById('shown').textContent+=' (alert set)'">Alert</button>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class RoutineTests(unittest.IsolatedAsyncioTestCase):
    async def test_routines_run_with_fill_ins_stop_on_a_bad_step_and_record(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    url = 'https://charts.test/chart/abc/'
                    await page.goto(url)
                    runtime = Browser()
                    runtime._context, runtime._page = context, page
                    store = SiteMaps(Path(directory) / 'maps')
                    for name, tag, label, attrs in (('Symbol search', 'button', 'Symbol search', [['id', 'search']]),
                                                    ('Symbol input', 'input', 'Symbol', [['id', 'symbol'], ['aria-label', 'Symbol']]),
                                                    ('Alert', 'button', 'Alert', [['id', 'alert']])):
                        store.save_target({'id': name, 'url': url, 'name': name, 'kind': 'button', 'status': 'taught_not_executed',
                                           'descriptor': {'tag': tag, 'role': '', 'label': label if tag != 'input' else '', 'attrs': attrs}})
                    tools = {}

                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register
                    register_target_tools(tool, runtime, lambda image, name: '', lambda: None, store)

                    with self.assertRaisesRegex(LookupError, 'Not taught'):
                        await tools['site_routine_save']('Bad', [{'do': 'click', 'target': 'Nope'}])
                    with self.assertRaisesRegex(ValueError, 'list "pair" in params'):
                        await tools['site_routine_save']('Open pair', [{'do': 'type', 'target': 'Symbol input', 'text': '{pair}'}])
                    saved = await tools['site_routine_save']('Open pair', [
                        {'do': 'click', 'target': 'Symbol search'},
                        {'do': 'type', 'target': 'Symbol input', 'text': '{pair}', 'submit': True},
                        {'do': 'wait_text', 'text': 'Chart: {pair}'},
                        {'do': 'click', 'target': 'Alert', 'expect': '(alert set)'}], params=['pair'], description='Pull up a pair')
                    self.assertEqual(saved['steps'], 4)
                    with self.assertRaisesRegex(ValueError, 'Fill in pair'):
                        await tools['site_routine_run']('open pair')
                    result = await tools['site_routine_run']('open pair', {'pair': 'EURUSD'}, site='charts')
                    self.assertEqual(result['result'], 'completed', result)
                    self.assertEqual(await page.inner_text('#shown'), 'Chart: EURUSD (alert set)')
                    note = (Path(directory) / 'maps' / 'Charts' / 'Routines' / 'Open pair.md').read_text(encoding='utf-8')
                    self.assertIn('Last run:', note)
                    self.assertIn('completed', note)

                    # A step whose element is gone stops the run there.
                    await page.evaluate("document.getElementById('alert').remove()")
                    result = await tools['site_routine_run']('Open pair', {'pair': 'GBPUSD'})
                    self.assertEqual((result['result'], result['failed_step']), ('stopped', 4))
                    self.assertEqual(await page.inner_text('#shown'), 'Chart: GBPUSD')

                    # Recording the owner: real clicks and typing become steps.
                    await page.goto(url)
                    await tools['site_routine_record_start']('Open pair by hand', {'pair': 'USDJPY'})
                    await page.click('#search')
                    await page.fill('#symbol', 'USDJPY')
                    await page.press('#symbol', 'Enter')
                    polled = await tools['site_routine_record_poll']()
                    self.assertEqual([s['do'] for s in polled['steps']], ['click', 'type'])
                    done = await tools['site_routine_record_finish']('Recorded by hand')
                    self.assertEqual(done['params'], ['pair'])
                    routine = store.routine(store.site_named('charts'), 'Open pair by hand')
                    self.assertEqual(routine['steps'][1], {'do': 'click', 'target': 'Symbol search', 'page': '/chart/abc/'})
                    self.assertEqual((routine['steps'][2]['target'], routine['steps'][2]['text'], routine['steps'][2]['submit']),
                                     ('Symbol input', '{pair}', True))
                    await page.goto(url)
                    result = await tools['site_routine_run']('Open pair by hand', {'pair': 'AUDCAD'})
                    self.assertEqual(result['result'], 'completed', result)
                    self.assertEqual(await page.inner_text('#shown'), 'Chart: AUDCAD')
                    # Site shortcuts: "/" opens the search box; a routine can use it.
                    await page.goto(url)
                    await tools['site_shortcut_add']('Search bar', '/', 'focuses the symbol search')
                    pressed = await tools['site_shortcut_press']('search bar')
                    self.assertEqual(pressed['pressed'], '/')
                    self.assertTrue(await page.is_visible('#symbol'))
                    await page.goto(url)
                    await tools['site_routine_save']('Pair by shortcut', [
                        {'do': 'shortcut', 'name': 'Search bar'},
                        {'do': 'type', 'text': '{pair}', 'submit': True}], params=['pair'])
                    result = await tools['site_routine_run']('Pair by shortcut', {'pair': 'NZDUSD'})
                    self.assertEqual(result['result'], 'completed', result)
                    self.assertEqual(await page.inner_text('#shown'), 'Chart: NZDUSD')
                    # Owner-presses-orders site: a routine never presses an order button;
                    # a hand-off step stops there and outlines it for the owner.
                    import json, order_guard
                    policy = Path(directory) / 'policy.json'
                    policy.write_text(json.dumps({'ownerPressesOrders': ['charts.test']}), encoding='utf-8')
                    order_guard.POLICY_FILE = policy
                    store.save_target({'id': 'review', 'url': url, 'name': 'Review', 'kind': 'button', 'status': 'taught_not_executed',
                                       'descriptor': {'tag': 'button', 'role': '', 'label': 'Review Order', 'attrs': [['id', 'review']]}})
                    await page.goto(url)
                    await tools['site_routine_save']('Bad order', [{'do': 'click', 'target': 'Review'}])
                    result = await tools['site_routine_run']('Bad order')
                    self.assertEqual(result['result'], 'stopped')
                    self.assertIn('owner presses order buttons', result['error'])
                    self.assertEqual(await page.inner_text('#shown'), 'Chart: none')
                    await tools['site_routine_save']('Set up order', [
                        {'do': 'shortcut', 'name': 'Search bar'}, {'do': 'type', 'text': '{pair}', 'submit': True},
                        {'do': 'handoff', 'message': 'Ready: press Review Order yourself.'}], params=['pair'])
                    result = await tools['site_routine_run']('Set up order', {'pair': 'EURUSD'})
                    self.assertEqual((result['result'], result['order_buttons_outlined']), ('ready_for_owner', 1))
                    self.assertIn('press Review Order yourself', result['tell_the_owner'])
                    self.assertEqual(result['mouse_on'], 'Review Order')
                    self.assertTrue(await page.evaluate("window.hovered === true"))  # The page saw the mouse arrive.
                    self.assertTrue(await page.evaluate("getComputedStyle(document.getElementById('review')).outlineStyle === 'solid'"))
                    # Enter outside a search box is refused there too.
                    await page.focus('#review')
                    with self.assertRaises(PermissionError):
                        await order_guard.check_enter(page)
                    overview = (Path(directory) / 'maps' / 'Charts' / 'Charts.md').read_text(encoding='utf-8')
                    self.assertIn('- `/`: Search bar (focuses the symbol search)', overview)
                    self.assertIn('[[Routines/Open pair by hand|Open pair by hand]] (fill in: pair)', overview)
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
