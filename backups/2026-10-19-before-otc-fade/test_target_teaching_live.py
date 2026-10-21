"""Real Chrome fixture covering owner teaching and scrolling; no user sites."""
import os
import tempfile
import unittest
from pathlib import Path
from playwright.async_api import async_playwright
from browser import Browser
from browser_targets import TargetStore, register_target_tools


@unittest.skipUnless(os.environ.get('LOCALTOOLS_LIVE_TEST') == '1', 'Opt-in isolated Chrome test')
class TeachingTests(unittest.IsolatedAsyncioTestCase):
    async def test_teaching_reacquires_moved_targets_and_maps_only_menu(self):
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                chrome = await pw.chromium.launch(channel='chrome', headless=True)
                try:
                    context = await chrome.new_context(viewport={'width': 1000, 'height': 700}, device_scale_factor=2)
                    page = await context.new_page()
                    html = '''<style>body{height:2000px}#menu{height:180px;width:250px;overflow-y:auto}li{height:36px;list-style:none}</style>
                    <button id="open" onclick="window.clicks=(window.clicks||0)+1">Open settings</button>
                    <ul id="menu">''' + ''.join(f'<li role="option">Item {i:02}</li>' for i in range(30)) + '</ul>'
                    await page.route('**/*', lambda route: route.fulfill(body=html, content_type='text/html'))
                    await page.goto('http://teaching.test/menu')
                    runtime = Browser()
                    runtime._context, runtime._page = context, page
                    store = TargetStore(Path(directory) / 'targets.sqlite')
                    tools = {}
                    def tool():
                        def register(fn):
                            tools[fn.__name__] = fn
                            return fn
                        return register
                    images = []
                    def save(image, name):
                        path = str(Path(directory) / (name + '.png'))
                        image.save(path)
                        images.append(path)
                        return path
                    recall = register_target_tools(tool, runtime, save, lambda: None, store)
                    await tools['browser_teach_start']('Settings button', expected_text='Settings panel')
                    with self.assertRaisesRegex(LookupError, 'NOTHING REPLACED'):
                        await tools['browser_teach_start']('Other button')
                    self.assertEqual((await tools['browser_teach_status']())['name'], 'Settings button')
                    with self.assertRaisesRegex(LookupError, 'NOT SAVED'):
                        await tools['browser_teach_finish']()
                    await page.locator('#open').click()
                    self.assertEqual((await tools['browser_teach_status']())['status'], 'marked_not_confirmed')
                    self.assertEqual(await page.evaluate('window.clicks||0'), 0)
                    with self.assertRaisesRegex(LookupError, 'NOT SAVED'):
                        await tools['browser_teach_finish']()
                    await page.get_by_text('Confirm taught target', exact=True).click()
                    self.assertEqual((await tools['browser_teach_status']())['status'], 'confirmed_not_saved')
                    with self.assertRaisesRegex(LookupError, 'NOTHING REPLACED'):
                        await tools['browser_teach_start']('Other button')
                    record = await tools['browser_teach_finish']()
                    self.assertEqual((await tools['browser_teach_status']())['status'], 'saved')
                    self.assertEqual((await tools['browser_target_find']('settings_button'))['target_id'], record['id'])
                    self.assertTrue(Path(record['reference_image']).exists())
                    self.assertEqual((await tools['browser_teach_finish']())['id'], record['id'])
                    await page.locator('#open').evaluate("e=>e.style.marginLeft='350px'")
                    before_images = len(images)
                    found = await tools['browser_target_find'](record['id'])
                    self.assertGreater(found['bounds']['x'], 300)
                    remembered = await recall('settings_button')
                    self.assertEqual(remembered['target_id'], record['id'])
                    self.assertGreater(remembered['bounds']['x'], 300)
                    self.assertIsNone(await recall('Unrelated button'))
                    # Exercise actual find/JEV tools with a deterministic decision stub.
                    import browser as browser_module
                    from unittest.mock import patch
                    from procedure_memory import ProcedureMemory
                    with patch.object(browser_module, 'Browser', return_value=runtime), patch.object(browser_module, 'register_target_tools', return_value=recall), patch.object(browser_module, 'ProcedureMemory', return_value=ProcedureMemory(Path(directory)/'procedures.sqlite')):
                        browser_module.register(tool, lambda action: None, save, lambda *args: '')
                    found_alias = await tools['browser_find']('settings_button')
                    self.assertEqual(found_alias['memory']['target_id'], record['id'])
                    def select(target, elements, shot):
                        self.assertEqual(target, 'Open settings')
                        self.assertEqual(len(elements), 1)
                        return {'ref': elements[0]['ref'], 'label': elements[0]['name']}
                    with patch.object(browser_module, 'select_target', side_effect=select):
                        decision = await tools['browser_jev_find']('settings_button')
                    self.assertEqual(decision['memory']['target_id'], record['id'])
                    self.assertFalse(decision['clicked'])
                    with patch.object(browser_module, 'TAKEOVER_FLAG', Path(directory)/'takeover'):
                        await tools['browser_visual_click']('settings_button')
                    self.assertEqual(await page.evaluate('window.clicks||0'), 1)
                    await page.evaluate('window.clicks=0')
                    self.assertEqual(len(images), before_images)
                    await page.locator('#open').evaluate("e=>e.textContent='Delete account'")
                    with self.assertRaises(LookupError):
                        await tools['browser_target_find'](record['id'])
                    with self.assertRaises(LookupError):
                        await tools['browser_find']('settings_button')
                    await page.reload()
                    self.assertIn('ref', await tools['browser_target_find'](record['id']))
                    await page.locator('#open').evaluate('e=>e.after(e.cloneNode(true))')
                    with self.assertRaises(LookupError):
                        await tools['browser_target_find'](record['id'])
                    await page.reload()
                    await tools['browser_teach_start']('Options menu', kind='scroll_container')
                    await page.locator('#menu li').first.click()
                    await page.get_by_text('Confirm taught target', exact=True).click()
                    menu = await tools['browser_teach_finish']()
                    mapping = await tools['browser_menu_map'](menu['id'], max_pages=20, capture_images=True)
                    self.assertEqual(len(mapping['entries']), 30)
                    self.assertTrue(mapping['reached_bottom'])
                    self.assertGreater(len(mapping['captures']), 1)
                    self.assertEqual(await page.evaluate('scrollY'), 0)
                    self.assertEqual(await page.locator('#menu').evaluate('e=>e.scrollTop'), 0)
                    last = await tools['browser_menu_find'](menu['id'], 'Item 29', max_pages=20)
                    self.assertEqual(last['label'], 'Item 29')
                    self.assertGreater(await page.locator('#menu').evaluate('e=>e.scrollTop'), 0)
                    self.assertEqual(await page.evaluate('window.clicks||0'), 0)
                    with self.assertRaises(LookupError):
                        await tools['browser_menu_find'](menu['id'], 'Missing', max_pages=1)
                    # Recycled rows: only a handful of nodes exist at each position.
                    await page.locator('#menu').evaluate("""e=>{
                      e.innerHTML='<div style="height:1080px;position:relative"></div>';e.scrollTop=0;
                      const render=()=>{const first=Math.floor(e.scrollTop/36);e.firstChild.innerHTML=Array.from({length:7},(_,i)=>first+i).filter(i=>i<30).map(i=>`<li role="option" style="position:absolute;top:${i*36}px;height:36px">Virtual ${String(i).padStart(2,'0')}</li>`).join('');};
                      e.addEventListener('scroll',render);render();
                    }""")
                    virtual = await tools['browser_menu_map'](menu['id'], max_pages=20)
                    self.assertEqual(len(virtual['entries']), 30)
                    self.assertEqual((await tools['browser_menu_find'](menu['id'], 'Virtual 29', max_pages=20))['label'], 'Virtual 29')
                    # Custom menu: overflow hidden and owner clicks its wrapper padding.
                    await page.reload()
                    await page.locator('#menu').evaluate("e=>{e.style.overflowY='hidden';const w=document.createElement('div');w.id='wrapper';w.style.padding='20px';e.before(w);w.append(e);}")
                    await tools['browser_teach_start']('Custom menu', kind='scroll_container')
                    await page.locator('#wrapper').click(position={'x':5,'y':5})
                    await page.get_by_text('Confirm taught target', exact=True).click()
                    custom = await tools['browser_teach_finish']()
                    self.assertIn(['id','menu'], custom['descriptor']['attrs'])
                    self.assertEqual(len((await tools['browser_menu_map'](custom['id'], max_pages=20))['entries']),30)
                    # Area selection identifies the scroll element without activating a row.
                    async def drag(x,y,width,height):
                        await page.mouse.move(x,y)
                        await page.mouse.down()
                        await page.mouse.move(x+width,y+height,steps=5)
                        await page.mouse.up()
                    bounds=await page.locator('#menu').bounding_box()
                    await tools['browser_teach_start']('Drawn menu',kind='scroll_container',selection='area')
                    await drag(bounds['x']+2,bounds['y']+2,bounds['width']-4,bounds['height']-4)
                    await page.get_by_text('Confirm taught target',exact=True).click()
                    drawn=await tools['browser_teach_finish']()
                    self.assertEqual(len((await tools['browser_menu_map'](drawn['id'],max_pages=20))['entries']),30)
                    await tools['browser_teach_start']('Chart focus',kind='region')
                    await drag(400,200,200,120)
                    with self.assertRaisesRegex(LookupError,'NOT SAVED'):
                        await tools['browser_teach_finish']()
                    await page.get_by_text('Confirm taught target',exact=True).click()
                    region=await tools['browser_teach_finish']()
                    capture=await tools['browser_region_capture'](region['id'])
                    from PIL import Image
                    with Image.open(capture['image']) as image:
                        self.assertEqual(image.size,(400,240)) # device scale factor 2
                    with self.assertRaisesRegex(LookupError,'capture area'):
                        await tools['browser_target_find'](region['id'])
                    await page.set_viewport_size({'width':900,'height':700})
                    with self.assertRaisesRegex(LookupError,'stale'):
                        await tools['browser_region_capture'](region['id'])
                    await page.set_viewport_size({'width':1000,'height':700})
                    await page.reload()
                    with self.assertRaisesRegex(LookupError,'stale'):
                        await tools['browser_region_capture'](region['id'])
                    await tools['browser_teach_start']('Cancelled')
                    await tools['browser_teach_cancel']()
                    self.assertEqual((await tools['browser_teach_status']())['status'], 'cancelled_or_expired')
                    with self.assertRaises(LookupError):
                        await tools['browser_teach_finish']()
                    import browser_mapping
                    await page.evaluate("() => {const b=document.createElement('button');b.id='correct';b.textContent='Correct control';b.onclick=()=>window.clicks=(window.clicks||0)+1;document.body.prepend(b);}")
                    await runtime.snapshot()
                    candidates=[e['ref'] for e in runtime._refs.values() if e['tag']=='button']
                    def propose(target,elements,shot):
                        return {'ref':next(e['ref'] for e in elements if e['name']=='Open settings')}
                    with patch.object(browser_mapping,'select_target',side_effect=propose):
                        batch=await tools['browser_map_propose'](['Settings proposal','Reject me','Correct me'],candidates)
                    self.assertFalse(batch['saved'])
                    with self.assertRaisesRegex(LookupError,'NOT SAVED'):
                        await tools['browser_map_finish']()
                    with self.assertRaisesRegex(LookupError,'NOTHING REPLACED'):
                        await tools['browser_teach_start']('Interrupt batch')
                    await page.get_by_text('Confirm proposal',exact=True).click()
                    await page.get_by_text('Reject proposal',exact=True).click()
                    await page.get_by_text('Choose different button',exact=True).click()
                    await page.locator('#correct').click()
                    self.assertEqual(await page.evaluate('window.clicks||0'),0)
                    await page.get_by_text('Confirm proposal',exact=True).click()
                    saved=await tools['browser_map_finish']()
                    self.assertEqual([r['name'] for r in saved['saved']],['Settings proposal','Correct me'])
                    self.assertEqual(saved['rejected'],['Reject me'])
                    self.assertEqual(await tools['browser_map_finish'](),saved)
                    self.assertEqual((await tools['browser_target_find']('Correct me'))['label'],'Correct control')
                    with patch.object(browser_mapping,'select_target',side_effect=propose):
                        await tools['browser_map_propose'](['Changed proposal'],candidates)
                    await page.get_by_text('Confirm proposal',exact=True).click()
                    await page.locator('#open').evaluate("e=>e.textContent='Changed action'")
                    with self.assertRaisesRegex(LookupError,'changed'):
                        await tools['browser_map_finish']()
                    self.assertNotIn('Changed proposal',[r['name'] for r in store.list_targets(page.url)])
                    await tools['browser_teach_cancel']()
                finally:
                    await chrome.close()
