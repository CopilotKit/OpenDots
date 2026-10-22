"""Real Chrome fixture for setting the trade expiry, built from the structure of
Pocket Option's Time picker (read from the owner's page); local page only."""
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

PAGE = '''<div class="block block--expiration-inputs"><div class="block__title">Time</div>
<div class="block__control control"><div class="control__value value value--several-items" onclick="toggle()">
<div class="value__val">00:00:11</div></div></div></div>
<div class="drop-down-modal trading-panel-modal expiration-inputs-list-modal" style="display:none">
 <div class="trading-panel-modal__in">
  <div class="rw"><a class="btn-plus">+</a><div class="input-field-wrapper"><input type="text" value="00"></div><a class="btn-minus">-</a></div>
  <div class="rw"><a class="btn-plus">+</a><div class="input-field-wrapper"><input type="text" value="00"></div><a class="btn-minus">-</a></div>
  <div class="rw"><a class="btn-plus">+</a><div class="input-field-wrapper"><input type="text" value="11"></div><a class="btn-minus">-</a></div>
 </div>
 <div class="trading-panel-modal__dops dops"><div class="dops__timeframes">
  <div class="dops__timeframes-item">S3</div><div class="dops__timeframes-item">S15</div><div class="dops__timeframes-item">S30</div>
  <div class="dops__timeframes-item">M1</div><div class="dops__timeframes-item">M3</div><div class="dops__timeframes-item">M5</div>
  <div class="dops__timeframes-item">M30</div><div class="dops__timeframes-item">H1</div><div class="dops__timeframes-item">H4</div>
 </div></div>
</div>
<script>
const panel = document.querySelector('.expiration-inputs-list-modal'), shown = document.querySelector('.value__val');
const boxes = [...panel.querySelectorAll('input')];
const pad = n => String(n).padStart(2, '0');
function show(s) { shown.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
  [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].forEach((v, i) => boxes[i].value = pad(v)); }
function toggle() { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; }
const presets = {S3: 3, S15: 15, S30: 30, M1: 60, M3: 180, M5: 300, M30: 1800, H1: 3600, H4: 14400};
panel.querySelectorAll('.dops__timeframes-item').forEach(e => e.onclick = () => show(presets[e.textContent]));
boxes.forEach(b => b.addEventListener('change', () => show(+boxes[0].value * 3600 + +boxes[1].value * 60 + +boxes[2].value)));
</script>'''


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class SetExpiryTests(unittest.IsolatedAsyncioTestCase):
    async def test_sets_presets_and_custom_times_and_confirms_them(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700})
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(body=PAGE, content_type='text/html'))
                    await page.goto('http://expiry.test/trade')
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
                    shown = lambda: page.locator('.value__val').inner_text()
                    closed = lambda: page.evaluate("getComputedStyle(document.querySelector('.expiration-inputs-list-modal')).display === 'none'")

                    # Presets.
                    result = await tools['browser_set_expiry']('30s')
                    self.assertEqual((result['expiry'], result['was'], result['changed']), ('00:00:30', '00:00:11', True))
                    self.assertEqual(await shown(), '00:00:30')
                    self.assertTrue(await closed())
                    await tools['browser_set_expiry']('M5')
                    self.assertEqual(await shown(), '00:05:00')

                    # Times without a preset are typed into the boxes.
                    await tools['browser_set_expiry']('5s')
                    self.assertEqual(await shown(), '00:00:05')
                    await tools['browser_set_expiry']('2 min')
                    self.assertEqual(await shown(), '00:02:00')
                    self.assertTrue(await closed())

                    # Already set: nothing to do.
                    self.assertFalse((await tools['browser_set_expiry']('00:02:00'))['changed'])
                    with self.assertRaises(ValueError):
                        await tools['browser_set_expiry']('1s')
                    with self.assertRaises(ValueError):
                        await tools['browser_set_expiry']('soon')
                finally:
                    await chrome.close()


if __name__ == '__main__':
    unittest.main()
