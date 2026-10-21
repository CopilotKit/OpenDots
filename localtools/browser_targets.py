"""Owner-taught DOM targets and bounded scroll-container discovery."""
import asyncio
import io
import json
import re
import time
import uuid
from pathlib import Path
from PIL import Image
from procedure_memory import ProcedureMemory, page_context
from site_maps import SiteMaps


DESCRIBE = r"""e => {
 const label = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || '').trim().replace(/\s+/g,' ').slice(0,160);
 const attrs = ['id','data-testid','data-test','aria-label','name','placeholder'].flatMap(key => e.getAttribute(key) ? [[key,e.getAttribute(key)]] : []);
 const r=e.getBoundingClientRect();
 return {tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',label,attrs,
 bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};
}"""

ARM = r"""({name,kind,describe,passThrough=0}) => {
 window.__dotsTeach?.cancel?.();
 const describeElement = eval('(' + describe + ')');
 const badge=document.createElement('div');
 const markText='Teach target: '+name+' — click once to mark it (no action). Escape cancels.';
 // Buttons that only appear after another click (e.g. Double Up after BUY): the
 // owner's first clicks go through to the page as normal, the next one marks.
 const passText=n=>'Teach target: '+name+' — your next '+(n===1?'click goes':n+' clicks go')+' through to the page as normal; then click the button to mark it. Escape cancels.';
 badge.textContent=passThrough>0?passText(passThrough):markText;
 Object.assign(badge.style,{position:'fixed',bottom:'12px',left:'12px',padding:'14px',background:'#172554',color:'white',font:'16px sans-serif',zIndex:'2147483647',pointerEvents:'none'});
 document.documentElement.appendChild(badge);
 const state={kind,name,started:Date.now(),target:null,descriptor:null,passThrough,letThrough:passThrough};
 const cancel=()=>{for(const event of ['pointerdown','pointerup','mousedown','mouseup'])window.removeEventListener(event,block,true);window.removeEventListener('click',pick,true);window.removeEventListener('keydown',key,true);clearTimeout(timer);badge.remove();};
 const block=e=>{if(e.isTrusted&&state.letThrough<=0){e.preventDefault();e.stopImmediatePropagation();}};
 const key=e=>{if(e.key==='Escape'){cancel();state.cancelled=true;}};
 const pick=e=>{
   if(!e.isTrusted)return;
   if(state.letThrough>0){state.letThrough--;badge.textContent=state.letThrough>0?passText(state.letThrough):'Teach target: '+name+' — now click the button to mark it (no action). Escape cancels.';return;}
   e.preventDefault();e.stopImmediatePropagation();
   let target=e.target;
   if(kind==='scroll_container'){
     const scrollable=x=>{const s=getComputedStyle(x);return /auto|scroll|hidden/.test(s.overflowY)&&x.clientHeight>0&&x.scrollHeight>x.clientHeight+2;};
     const clicked=target;
     while(target && target!==document.body){if(scrollable(target))break;target=target.parentElement;}
     if(!target||target===document.body){const children=Array.from(clicked.querySelectorAll('*')).filter(scrollable);target=children.length===1?children[0]:null;}
     if(!target||target===document.body){badge.textContent='No scrollable menu here. Click inside the menu, or Escape to cancel.';return;}
   }else target=target.closest('button,a,[role=button],[role=option],[role=menuitem],input,select,[onclick]')||target;
   if(target===document.body||target===document.documentElement){badge.textContent='Choose a specific control, not the page background.';return;}
   state.target=target;state.descriptor=describeElement(target);cancel();
   const review=document.createElement('div');
   Object.assign(review.style,{position:'fixed',bottom:'12px',left:'12px',padding:'16px',background:'#172554',color:'white',font:'16px sans-serif',zIndex:'2147483647'});
   const text=document.createElement('p');text.textContent='Save "'+name+'" as '+state.descriptor.tag+' — '+(state.descriptor.label||'(unlabelled)')+'?';review.appendChild(text);
   const yes=document.createElement('button');yes.textContent='Confirm taught target';
   const no=document.createElement('button');no.textContent='Cancel taught target';
   yes.onclick=e=>{if(!e.isTrusted)return;e.stopPropagation();state.confirmed=true;review.remove();};
   no.onclick=e=>{if(!e.isTrusted)return;e.stopPropagation();state.cancelled=true;review.remove();};
   review.append(yes,no);document.documentElement.appendChild(review);
   state.cancel=()=>{state.cancelled=true;review.remove();};
 };
 const timer=setTimeout(()=>{cancel();state.cancelled=true;},120000);
 state.cancel=cancel;window.__dotsTeach=state;
 for(const event of ['pointerdown','pointerup','mousedown','mouseup'])window.addEventListener(event,block,true);window.addEventListener('click',pick,true);window.addEventListener('keydown',key,true);
 return {status:'waiting_for_owner',name,kind,expires_in_seconds:120};
}"""

AREA_ARM = r"""({name,kind,describe,token}) => {
 window.__dotsTeach?.cancel?.();
 const describeElement=eval('('+describe+')');
 window.__dotsRegionDocument ??= token;
 const state={name,kind,started:Date.now()};window.__dotsTeach=state;
 const layer=document.createElement('div');
 Object.assign(layer.style,{position:'fixed',inset:'0',zIndex:'2147483647',cursor:'crosshair',background:'rgba(0,0,0,.12)',touchAction:'none'});
 const badge=document.createElement('div');badge.textContent='Drag a rectangle around '+name+'. Escape cancels.';
 Object.assign(badge.style,{position:'absolute',top:'8px',left:'8px',background:'#172554',color:'white',padding:'12px',font:'16px sans-serif',pointerEvents:'none'});
 const box=document.createElement('div');Object.assign(box.style,{position:'absolute',border:'2px solid #38bdf8',background:'rgba(56,189,248,.15)',pointerEvents:'none',display:'none',boxSizing:'border-box'});
 layer.append(badge,box);document.documentElement.append(layer);
 let start=null,rect=null,timer;
 const key=e=>{if(e.key==='Escape'){e.preventDefault();state.cancel();}};
 const cleanup=()=>{clearTimeout(timer);window.removeEventListener('keydown',key,true);layer.remove();};
 state.cancel=()=>{state.cancelled=true;cleanup();};
 const update=e=>{rect={x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(e.clientX-start.x),height:Math.abs(e.clientY-start.y)};Object.assign(box.style,{display:'block',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});};
 layer.addEventListener('pointerdown',e=>{if(!e.isTrusted||e.button!==0||state.descriptor)return;e.preventDefault();e.stopPropagation();start={x:e.clientX,y:e.clientY};layer.setPointerCapture(e.pointerId);update(e);});
 layer.addEventListener('pointermove',e=>{if(start&&!state.descriptor)update(e);});
 layer.addEventListener('pointerup',e=>{
   if(!e.isTrusted||!start||state.descriptor)return;e.preventDefault();e.stopPropagation();update(e);start=null;
   if(rect.width<12||rect.height<12){badge.textContent='Area too small. Drag a larger rectangle.';return;}
   if(kind==='scroll_container'){
     const candidates=Array.from(document.querySelectorAll('*')).filter(x=>{
       if(layer.contains(x)||x===document.body||x===document.documentElement)return false;
       const s=getComputedStyle(x),r=x.getBoundingClientRect();
       if(!/auto|scroll|hidden/.test(s.overflowY)||x.scrollHeight<=x.clientHeight+2||s.visibility==='hidden'||r.width<1||r.height<1)return false;
       const overlap=Math.max(0,Math.min(rect.x+rect.width,r.right)-Math.max(rect.x,r.left))*Math.max(0,Math.min(rect.y+rect.height,r.bottom)-Math.max(rect.y,r.top));
       return overlap/(rect.width*rect.height)>=.8 && overlap/(r.width*r.height)>=.5;
     });
     if(candidates.length!==1){badge.textContent='No unique scroll container in this area. Draw tightly around the menu, or cancel and teach kind region for visual capture.';return;}
     state.target=candidates[0];state.descriptor=describeElement(state.target);
   }else{
     state.descriptor={tag:'region',role:'',label:name,attrs:[],bounds:rect};
     state.region_context={token:window.__dotsRegionDocument,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}};
   }
   badge.textContent='Save "'+name+'" as '+state.descriptor.tag+' — '+state.descriptor.label+'?';badge.style.pointerEvents='auto';
   for(const [label,confirm] of [['Confirm taught target',true],['Cancel taught target',false]]){
     const button=document.createElement('button');button.textContent=label;button.onclick=event=>{if(!event.isTrusted)return;event.stopPropagation();if(confirm){state.confirmed=true;cleanup();}else state.cancel();};badge.append(button);
   }
 });
 layer.addEventListener('click',e=>e.stopPropagation());
 layer.addEventListener('wheel',e=>e.preventDefault(),{passive:false});
 window.addEventListener('keydown',key,true);timer=setTimeout(state.cancel,120000);
 return {status:'waiting_for_owner',name,kind,selection:'area',expires_in_seconds:120};
}"""

RESOLVE = r"""d => {
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none';};
 let candidates=Array.from(document.getElementsByTagName(d.tag));
 if(d.attrs.length)candidates=candidates.filter(e=>d.attrs.every(([key,value])=>e.getAttribute(key)===value));
 else candidates=candidates.filter(e=>(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||'').trim().replace(/\s+/g,' ').slice(0,160)===d.label);
 candidates=candidates.filter(e=>visible(e)&&(e.getAttribute('role')||'')===d.role);
 if(d.kind!=='scroll_container'&&d.label)candidates=candidates.filter(e=>(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||'').trim().replace(/\s+/g,' ').slice(0,160)===d.label);
 if(candidates.length!==1)return null;
 return candidates[0];
}"""

ROWS = r"""e => {
 const box=e.getBoundingClientRect();
 const nodes=Array.from(e.querySelectorAll('[role=option],[role=menuitem],li,button,a,[data-action]'));
 const source=nodes.length?nodes:Array.from(e.querySelectorAll('*')).filter(x=>x.children.length===0);
 const labels=source.filter(x=>{const r=x.getBoundingClientRect(),s=getComputedStyle(x);return r.width>1&&r.height>1&&r.bottom>box.top&&r.top<box.bottom&&s.display!=='none'&&s.visibility!=='hidden';}).map(x=>(x.innerText||x.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ')).filter(x=>x&&x.length<=200);
 return {labels:[...new Set(labels)].slice(0,500),top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight};
}"""


def target_name(value):
    return re.sub(r'[\W_]', '', value.casefold())


TEACH_STATUS = """() => {
 const s=window.__dotsTeach;
 if(!s)return {status:'not_started',saved:false};
 return {name:s.name,kind:s.kind,saved:!!s.saved,target_id:s.saved||null,
 clicks_to_let_through:s.letThrough||0,
 status:s.saved?'saved':s.cancelled?'cancelled_or_expired':s.confirmed?'confirmed_not_saved':s.descriptor?'marked_not_confirmed':'waiting_for_owner',
 captured_label:s.descriptor?.label||null};
}"""


class TargetStore(ProcedureMemory):
    def __init__(self, path):
        super().__init__(path)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS browser_targets(id TEXT PRIMARY KEY, context TEXT NOT NULL, data TEXT NOT NULL)')

    def save_target(self, value):
        value['updated_at'] = time.time()
        with self.connect() as db:
            db.execute('INSERT INTO browser_targets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (value['id'], value['context'], json.dumps(value)))
        return value

    def get_target(self, identity, url):
        with self.connect() as db:
            row = db.execute('SELECT data FROM browser_targets WHERE id=? AND context=?', (identity, page_context(url))).fetchone()
        if not row:
            matches = [record for record in self.list_targets(url) if target_name(record['name']) == target_name(identity) and record.get('status') != 'needs_reteach']
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise LookupError('Saved target name is ambiguous. Use a target ID from browser_targets.')
            raise LookupError('Taught target is not saved for this page. Use browser_targets for saved IDs/names; teach missing targets.')
        return json.loads(row[0])

    def list_targets(self, url):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM browser_targets WHERE context=? ORDER BY rowid DESC LIMIT 100', (page_context(url),)).fetchall()]

    def forget_target(self, identity, url):
        with self.connect() as db:
            return bool(db.execute('DELETE FROM browser_targets WHERE id=? AND context=?', (identity, page_context(url))).rowcount)


def register_target_tools(tool, browser, save_image, ensure_control, store=None):
    # Taught targets live in the Obsidian site maps (one folder per site); the old
    # SQLite store is only read once to copy its targets over.
    if store is None:
        from site_maps import migrate_sqlite
        store = SiteMaps()
        data = Path(__file__).parent.parent / 'data'
        migrate_sqlite(store, data / 'browser-targets.sqlite', [data / 'output', Path(__file__).parent / 'output'])

    async def reference_image(page, element, prefix, bounds=None):
        box = bounds if bounds is not None else await element.bounding_box()
        width, height = await page.evaluate('() => [innerWidth, innerHeight]')
        if not box:
            raise LookupError('Target is not visible for a reference image.')
        left, top = max(0, box['x']), max(0, box['y'])
        right, bottom = min(width, box['x'] + box['width']), min(height, box['y'] + box['height'])
        if right <= left or bottom <= top:
            raise LookupError('Target is offscreen; no reference image captured.')
        shot = Image.open(io.BytesIO(await page.screenshot()))
        sx, sy = shot.width / width, shot.height / height
        return save_image(shot.crop((left*sx, top*sy, right*sx, bottom*sy)), prefix + uuid.uuid4().hex[:8])

    async def resolve(identity):
        # This page's target first; the same name taught on another page of the
        # site is used only if it is actually found here (layouts can differ).
        page = await browser.page()
        found = store.candidates(identity, page.url)
        here = [r for r in found if not r.get('elsewhere')]
        if len(here) > 1:
            raise LookupError('Saved target name is ambiguous on this page. Use a target ID from browser_targets.')
        if not found:
            store.get_target(identity, page.url)  # Raises the reason.
        for record in here or found:
            if record.get('status') == 'needs_reteach':
                raise LookupError('Mapping invalidated after a wrong-target capture. Teach and confirm the target again.')
            if record['kind'] == 'region':
                raise LookupError('This is a capture area, not a clickable target. Use browser_region_capture.')
            handle = await page.evaluate_handle(RESOLVE, record['descriptor'])
            element = handle.as_element()
            if element is not None:
                store.touch_target(record, page.url)
                return page, record, element
            await handle.dispose()
        raise LookupError('Taught target is missing or ambiguous. Reopen its menu or teach it again; no coordinates were reused.')

    async def current_ref(element):
        # Require a visible, uncovered target. Do not scroll the outer page.
        if not await element.is_visible() or not await element.is_enabled():
            raise LookupError('Target is hidden or disabled. No click was issued.')
        visible = await element.evaluate("e => { const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const top=document.elementFromPoint(x,y);return x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&(top===e||e.contains(top)); }")
        if not visible:
            raise LookupError('Target is offscreen or covered. No click was issued.')
        ref = await element.evaluate("e => { window.__ldNext ||= 1; if(!e.hasAttribute('data-ld-ref'))e.setAttribute('data-ld-ref',String(window.__ldNext++));return Number(e.getAttribute('data-ld-ref')); }")
        browser._refs.pop(ref, None)
        info, locator = await browser.element(ref)
        return {'ref': ref, 'label': info['name'], 'bounds': await locator.bounding_box(), 'clicked': False}

    @tool()
    async def browser_teach_start(name: str, kind: str = 'button', expected_text: str = '', selection: str = 'click', after_clicks: int = 0) -> dict:
        """Ask the owner to mark one browser target. Next user click is captured, not executed.
        kind: button, scroll_container, or region (named screenshot area).
        selection=area lets the owner drag around a scroll_container; region always
        uses a drag. Ask owner to mark and confirm, then finish next turn. Escape cancels.
        after_clicks=1 lets the owner's first click act normally (e.g. BUY) so they can
        mark a button that only appears after it (e.g. Double Up)."""
        if not 0 <= after_clicks <= 3 or (after_clicks and (kind != 'button' or selection != 'click')):
            raise ValueError('after_clicks is 0 to 3 and only for kind button with selection click.')
        if not name.strip() or len(name)>160 or len(expected_text)>200 or kind not in ('button', 'scroll_container', 'region') or selection not in ('click', 'area') or (kind == 'button' and selection == 'area'):
            raise ValueError('Use button/click, scroll_container with click or area, or region with area.')
        async with browser.lock:
            page = await browser.page()
            if not page_context(page.url):
                raise ValueError('Teach targets on an HTTP(S) page.')
            pending = await page.evaluate(TEACH_STATUS)
            if pending['status'] in ('waiting_for_owner', 'marked_not_confirmed', 'confirmed_not_saved'):
                raise LookupError(f'Teaching already active for "{pending["name"]}": {pending["status"]}. NOTHING REPLACED. Finish mark/confirm/save before starting another target. Cancel only if the owner wants to discard this selection.')
            result = await page.evaluate(AREA_ARM if kind == 'region' or selection == 'area' else ARM, {'name': name.strip(), 'kind': kind, 'describe': DESCRIBE, 'token': uuid.uuid4().hex, 'passThrough': after_clicks})
            await page.evaluate('(text)=>{window.__dotsTeach.expected=text}', expected_text)
            return result

    @tool()
    async def browser_teach_status() -> dict:
        """Read actual teaching state. Only status=saved proves persistence.
        Never ask the owner to click unless waiting_for_owner and the overlay is visible."""
        async with browser.lock:
            return await (await browser.page()).evaluate(TEACH_STATUS)

    @tool()
    async def browser_teach_cancel() -> dict:
        """Discard unsaved teaching only when the owner asks to cancel or switch targets.
        Does not delete saved mappings. Never use to bypass unfinished teaching."""
        async with browser.lock:
            page = await browser.page()
            await page.evaluate('() => {const s=window.__dotsTeach;if(s&&!s.saved){s.cancel?.();s.cancelled=true;}}')
            return await page.evaluate(TEACH_STATUS)

    @tool()
    async def browser_teach_finish() -> dict:
        """Save the owner's marked target and cropped reference image. Does not click.
        expected_text is a future verification criterion, not verified by teaching."""
        async with browser.lock:
            page = await browser.page()
            if await page.evaluate("() => window.__dotsTeach?.kind === 'mapping_batch'"):
                raise LookupError('Use browser_map_finish for the reviewed JEV batch. No single target saved.')
            state = await page.evaluate("() => {const s=window.__dotsTeach;return s?{name:s.name,kind:s.kind,descriptor:s.descriptor,cancelled:s.cancelled,expected:s.expected,saved:s.saved,confirmed:s.confirmed,region_context:s.region_context,pass_through:s.passThrough||0}:null}")
            if not state or state.get('cancelled'):
                raise LookupError('NOT SAVED: no active teaching session (not started, cancelled, expired, or page changed). No click receipt exists. Call browser_teach_start successfully before asking the owner to mark anything.')
            if state.get('saved'):
                return store.get_target(state['saved'], page.url)
            if not state.get('descriptor'):
                raise LookupError('NOT SAVED: waiting for the owner to mark a target. No target was taught.')
            if not state.get('confirmed'):
                raise LookupError(f'NOT SAVED: confirm the captured element in the browser: {state["descriptor"]["label"]}. Cancel if this is the wrong target.')
            descriptor = state['descriptor']
            descriptor['kind'] = state['kind']
            if state['kind'] == 'region':
                await validate_region(page, state['region_context'])
                crop = await reference_image(page, None, 'taught-region-', descriptor['bounds'])
                await validate_region(page, state['region_context'])
                record = store.save_target({'id': str(uuid.uuid4()), 'url': page.url, 'context': page_context(page.url), 'name': state['name'], 'kind': 'region', 'descriptor': descriptor, 'region_context': state['region_context'], 'reference_image': crop, 'status': 'capture_only'})
                await page.evaluate('(id)=>{window.__dotsTeach.saved=id}', record['id'])
                return record
            if not descriptor['attrs'] and not descriptor['label']:
                raise LookupError('This element has no persistent identity. Teach a labelled control or containing menu instead.')
            handle = await page.evaluate_handle('() => window.__dotsTeach.target')
            element = handle.as_element()
            try:
                if element is None or not await element.is_visible():
                    if not state.get('pass_through'):
                        raise LookupError('Marked element disappeared; teach again.')
                    # Brief buttons (shown after another click) are usually gone by
                    # now; the element's description was captured when it was marked.
                    crop = None
                else:
                    crop = await reference_image(page, element, 'taught-target-')
                record = store.save_target({'id': str(uuid.uuid4()), 'url': page.url, 'context': page_context(page.url), 'name': state['name'], 'kind': state['kind'], 'descriptor': descriptor, 'reference_image': crop, 'expected_text': state.get('expected', ''), 'status': 'taught_not_executed'})
                await page.evaluate('(id)=>{window.__dotsTeach.saved=id}', record['id'])
                return record
            finally:
                await handle.dispose()

    @tool()
    async def browser_region_capture(target_id: str) -> dict:
        """Capture a fresh screenshot of a named owner-drawn area for visual review.
        Does not locate or click objects. Reload, resize or outer page scroll requires
        re-teaching. Contents may have changed; inspect every returned image."""
        async with browser.lock:
            page = await browser.page()
            record = store.get_target(target_id, page.url)
            if record['kind'] != 'region' or record.get('status') == 'needs_reteach':
                raise LookupError('Teach a valid region first.')
            await validate_region(page, record['region_context'])
            image = await reference_image(page, None, 'region-capture-', record['descriptor']['bounds'])
            await validate_region(page, record['region_context'])
            return {'target_id': target_id, 'name': record['name'], 'image': image, 'bounds': record['descriptor']['bounds'], 'captured_at': time.time(), 'verification': 'Capture only; inspect current contents. No object identity or action is verified.'}

    async def validate_region(page, expected):
        current = await page.evaluate('() => ({token:window.__dotsRegionDocument,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}})')
        if current != expected:
            raise LookupError('Capture area is stale after navigation, resize or page scroll. Teach the area again.')

    @tool()
    async def browser_targets() -> dict:
        """List owner-taught targets for the current page, then the site's others
        (marked elsewhere: taught on another page, used only if found here). Recall never clicks."""
        async with browser.lock:
            return {'targets': store.list_targets((await browser.page()).url)}

    @tool()
    async def browser_target_forget(target_id: str) -> dict:
        """Forget a target on the current page when the owner asks. Reference image files remain in output."""
        async with browser.lock:
            return {'deleted': store.forget_target(target_id, (await browser.page()).url)}

    @tool()
    async def browser_target_find(target_id: str) -> dict:
        """Resolve a taught target to its current ref without screenshots or clicks.
        target_id accepts a saved ID or unique taught name. Use browser_click with
        the returned ref and saved expected_text."""
        async with browser.lock:
            _, record, element = await resolve(target_id)
            try:
                return {**await current_ref(element), 'target_id': record['id'], 'expected_text': record.get('expected_text', '')}
            finally:
                await element.dispose()

    async def scan(target_id, max_pages, capture_images, sought=None):
        if not 1 <= max_pages <= 20:
            raise ValueError('max_pages must be 1–20.')
        ensure_control()
        async with browser.lock:
            page, record, element = await resolve(target_id)
            original = None
            matched = False
            try:
                if record['kind'] != 'scroll_container':
                    raise ValueError('Teach the scrollable menu with kind=scroll_container first.')
                await current_ref(element)
                original = await element.evaluate('e=>e.scrollTop')
                await element.evaluate('e=>{e.scrollTop=0}')
                entries, captures = set(), []
                bottom = False
                for _ in range(max_pages):
                    ensure_control()
                    if await browser.page() is not page or page_context(page.url) != record['context']:
                        raise LookupError('Page changed during menu mapping.')
                    await asyncio.sleep(0.2)
                    observed = await element.evaluate(ROWS)
                    entries.update(observed['labels'])
                    if sought:
                        candidate = await element.evaluate_handle(r"""(e,label)=>{
                          const box=e.getBoundingClientRect();
                          const nodes=Array.from(e.querySelectorAll('*')).filter(x=>{
                            const r=x.getBoundingClientRect();return r.width>1&&r.height>1&&r.top>=box.top&&r.bottom<=box.bottom&&(x.innerText||x.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ')===label;
                          });
                          const leaves=nodes.filter(x=>!nodes.some(y=>y!==x&&x.contains(y)));
                          return leaves.length===1?leaves[0]:null;
                        }""", sought)
                        try:
                            found = candidate.as_element()
                            if found:
                                result = await current_ref(found)
                                matched = True
                                return {**result, 'menu_target_id': target_id}
                        finally:
                            await candidate.dispose()
                    capture = {'scroll_top': observed['top'], 'labels': observed['labels']}
                    if capture_images:
                        capture['image'] = await reference_image(page, element, 'menu-map-')
                    captures.append(capture)
                    bottom = observed['top'] + observed['height'] >= observed['total'] - 2
                    if bottom:
                        break
                    ensure_control()
                    moved = await element.evaluate('e=>{const before=e.scrollTop;e.scrollTop+=e.clientHeight*0.75;return e.scrollTop!==before}')
                    if not moved:
                        break
                if sought:
                    raise LookupError('Exact menu entry was not uniquely visible within the scan limit. No click was issued.')
                mapping = {'entries': sorted(entries), 'captures': captures, 'reached_bottom': bottom, 'coverage': 'Observed visible DOM labels; bottom reached does not prove all dynamic entries were loaded.'}
                record['menu_map'] = mapping
                store.save_target(record)
                return mapping
            finally:
                # A successful find leaves the intended row visible for its next click.
                if original is not None and not matched:
                    try:
                        ensure_control()
                        if await browser.page() is page:
                            await element.evaluate('(e,top)=>{e.scrollTop=top}', original)
                    except Exception:
                        pass
                await element.dispose()

    @tool()
    async def browser_menu_map(target_id: str, max_pages: int = 10, capture_images: bool = False) -> dict:
        """Map a taught scroll container with overlapping scrolls; deduplicate visible labels.
        Optional cropped screenshots support visual review. Restores original menu scroll.
        Bounded to 20 pages; never clicks an entry or claims exhaustive dynamic coverage."""
        return await scan(target_id, max_pages, capture_images)

    @tool()
    async def browser_menu_find(target_id: str, label: str, max_pages: int = 10) -> dict:
        """Scroll only a taught menu to find one exact visible entry, then return its ref.
        Reacquires virtualized rows. Leaves the match visible. Does not click."""
        if not label.strip() or len(label)>200:
            raise ValueError('Supply an exact menu label up to 200 characters.')
        return await scan(target_id, max_pages, False, ' '.join(label.split()))

    async def recall_name(name):
        # Caller owns browser.lock. Names are aliases, never executable instructions.
        normalize = lambda value: re.sub(r'[\W_]', '', value.casefold())
        key = normalize(name)
        url = (await browser.page()).url
        records = store.list_targets(url)
        matches = store.candidates(name, url) if key else []
        if not matches:
            if any(key and normalize(r['name']) == key for r in records):
                raise LookupError('This remembered mapping was invalidated. Re-teach it before use.')
            return None
        if all(r['kind'] == 'region' for r in matches):
            raise LookupError('This remembered name is a capture area, not a button. Use browser_region_capture with target ID ' + matches[0]['id'])
        _, record, element = await resolve(name)
        try:
            return {**await current_ref(element), 'target_id': record['id'], 'taught_name': record['name'], 'expected_text': record.get('expected_text', ''), 'source': 'owner_taught_memory'}
        finally:
            await element.dispose()

    from browser_mapping import register_mapping_tools
    register_mapping_tools(tool, browser, store, DESCRIBE, TEACH_STATUS, reference_image, current_ref)
    from site_routines import register_routine_tools
    register_routine_tools(tool, browser, store, resolve, current_ref, scan, ensure_control)
    from robinhood_ticket import register_robinhood_tools
    register_robinhood_tools(tool, browser, ensure_control)
    return recall_name
