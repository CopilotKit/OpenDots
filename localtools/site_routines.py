"""Routines on mapped sites: named steps on taught targets, with fill-ins.

A routine is the owner's way of doing something on a site once, written down
so a Dot can do it again: "Open pair" = click Symbol search, type {pair},
press Enter, wait for {pair}. It is recorded from the owner's own clicks and
typing (record_start / poll / finish) or written by a Dot after doing the task
(save). Running replays each step on the live page, finding each element again
by its taught name or description (never by old coordinates), checks it, and
stops at the first step that does not work.
"""
from __future__ import annotations

import asyncio
import re
import time

from procedure_memory import page_context
from site_maps import key, page_of
import order_guard

STEP_KINDS = ('open', 'click', 'type', 'key', 'shortcut', 'menu_pick', 'wait_text', 'wait', 'handoff')
FILL = re.compile(r'\{(\w+)\}')
WAIT_S = 8

RESOLVE_DESCRIPTOR = r"""d => {
 const text=e=>(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||e.getAttribute('placeholder')||'').trim().replace(/\s+/g,' ').slice(0,160);
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none';};
 let c=Array.from(document.getElementsByTagName(d.tag)).filter(visible);
 if(d.attrs&&d.attrs.length)c=c.filter(e=>d.attrs.every(([k,v])=>e.getAttribute(k)===v));
 else c=c.filter(e=>text(e)===d.label);
 if(c.length>1&&d.label)c=c.filter(e=>text(e)===d.label);
 return c.length===1?c[0]:null;
}"""

# Owner recording: notes each real click and typed value; nothing is blocked.
RECORD = r"""() => {
 if (window.__dotsRecord) return 'armed';
 const text=e=>(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||e.getAttribute('placeholder')||'').trim().replace(/\s+/g,' ').slice(0,160);
 const describe=e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',label:text(e),
   attrs:['id','data-testid','data-test','aria-label','name','placeholder'].flatMap(k=>e.getAttribute(k)?[[k,e.getAttribute(k)]]:[])});
 const state={events:[]};window.__dotsRecord=state;
 const field=e=>e.closest('input,textarea,[contenteditable=""],[contenteditable=true]');
 addEventListener('click',e=>{if(!e.isTrusted)return;
   const f=field(e.target);if(f)return;
   const t=e.target.closest('button,a,[role=button],[role=option],[role=menuitem],[role=tab],li,[onclick]')||e.target;
   if(t===document.body||t===document.documentElement)return;
   state.events.push({do:'click',descriptor:describe(t),at:Date.now()});},true);
 addEventListener('change',e=>{if(!e.isTrusted)return;const f=field(e.target);if(!f||f.type==='password')return;
   state.events.push({do:'type',descriptor:describe(f),text:f.value??f.innerText,at:Date.now()});},true);
 addEventListener('keydown',e=>{if(!e.isTrusted||!['Enter','Escape','Tab'].includes(e.key))return;const f=field(e.target);
   if(f&&f.type==='password')return;
   if(f&&e.key==='Enter')state.events.push({do:'type',descriptor:describe(f),text:f.value??f.innerText,submit:true,at:Date.now()});
   else if(!f)state.events.push({do:'key',key:e.key,at:Date.now()});},true);
 return 'armed';
}"""


def fill(text: str, values: dict) -> str:
    missing = [n for n in FILL.findall(text) if n not in values]
    if missing:
        raise ValueError(f'Fill in {", ".join(missing)} to run this routine.')
    return FILL.sub(lambda m: str(values[m.group(1)]), text)


def check_steps(steps: list, params: list) -> list:
    if not steps or len(steps) > 60:
        raise ValueError('A routine has 1 to 60 steps.')
    out = []
    for i, step in enumerate(steps, 1):
        step = {k: v for k, v in dict(step).items() if v not in (None, '')}
        if step.get('do') not in STEP_KINDS:
            raise ValueError(f'Step {i}: "do" is one of {", ".join(STEP_KINDS)}.')
        if step['do'] == 'shortcut' and not step.get('name'):
            raise ValueError(f'Step {i}: name the site shortcut to press.')
        if step['do'] in ('click', 'menu_pick') and not (step.get('target') or step.get('descriptor')):
            raise ValueError(f'Step {i}: name the taught target to {step["do"]}.')
        for name in FILL.findall(' '.join(str(v) for v in step.values() if isinstance(v, str))):
            if name not in params:
                raise ValueError(f'Step {i} uses {{{name}}}; list "{name}" in params.')
        out.append(step)
    return out


def register_routine_tools(tool, browser, store, resolve, current_ref, scan, ensure_control):
    recording: dict = {}

    async def element_for(page, step):
        if step.get('target'):
            _, record, element = await resolve(step['target'])
            return element
        handle = await page.evaluate_handle(RESOLVE_DESCRIPTOR, step['descriptor'])
        element = handle.as_element()
        if element is None:
            await handle.dispose()
            label = step['descriptor'].get('label') or step['descriptor'].get('tag')
            raise LookupError(f'"{label}" is not on the page (or not unique). Re-record this step or teach it.')
        return element

    async def text_shows(page, text, seconds):
        deadline = time.time() + seconds
        while True:
            labels = page.get_by_text(text, exact=False)
            for i in range(min(await labels.count(), 20)):
                if await labels.nth(i).is_visible():
                    return True
            if time.time() >= deadline:
                return False
            await asyncio.sleep(0.3)

    async def press_keys(page, keys: str):
        # Out of any text box first, or "/" and "O" are typed instead of acting.
        await page.evaluate('() => document.activeElement && document.activeElement !== document.body && document.activeElement.blur()')
        for combo in keys.split():
            await page.keyboard.press(combo)
            await asyncio.sleep(0.15)

    async def run_step(step, values, site=None):
        ensure_control()
        if step['do'] == 'menu_pick':
            found = await scan(step['target'], 10, False, ' '.join(fill(step['label'], values).split()))
            async with browser.lock:
                _, locator = await browser.element(found['ref'])
                await locator.click(timeout=5000)
            return
        async with browser.lock:
            page = await browser.page()
            if await page.evaluate('() => !!(window.__dotsTeach && !window.__dotsTeach.cancelled && !window.__dotsTeach.saved)'):
                raise PermissionError('Teaching is waiting for the owner. Finish or cancel it first.')
            if step['do'] == 'open':
                url = fill(step['url'], values)
                if page_context(page.url) != page_context(url):  # Already there: no reload.
                    await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            elif step['do'] == 'key':
                if re.search(r'enter|return', step['key'], re.I):
                    await order_guard.check_enter(page)
                await page.keyboard.press(step['key'])
            elif step['do'] == 'type' and not (step.get('target') or step.get('descriptor')):
                # Into whatever is focused, e.g. the search box a shortcut just opened.
                if step.get('submit'):
                    await order_guard.check_enter(page)
                await page.keyboard.insert_text(fill(step.get('text', ''), values))
                if step.get('submit'):
                    await page.keyboard.press('Enter')
            elif step['do'] == 'shortcut':
                await press_keys(page, store.shortcut(site or store.site_for(page.url), step['name'])['keys'])
            elif step['do'] == 'wait':
                await asyncio.sleep(min(10.0, float(step.get('seconds', 1))))
            elif step['do'] == 'wait_text':
                if not await text_shows(page, fill(step['text'], values), float(step.get('seconds', WAIT_S))):
                    raise LookupError(f'"{fill(step["text"], values)}" did not show.')
            else:
                element = await element_for(page, step)
                try:
                    found = await current_ref(element)  # Visible, enabled, not covered.
                    if step['do'] == 'click':
                        order_guard.check_click(page.url, found.get('label') or '')
                        await element.click(timeout=5000)
                    else:
                        text = fill(step.get('text', ''), values)
                        try:
                            await element.fill(text, timeout=5000)
                        except Exception:
                            await element.click(timeout=5000)
                            await page.keyboard.press('Control+A')
                            await page.keyboard.insert_text(text)
                        if step.get('submit'):
                            await order_guard.check_enter(page)
                            await page.keyboard.press('Enter')
                finally:
                    await element.dispose()
            await browser.settle()
            if step.get('expect') and not await text_shows(page, fill(step['expect'], values), WAIT_S):
                raise LookupError(f'Expected "{fill(step["expect"], values)}" to show after this step; it did not.')

    async def site_of(site: str):
        if site:
            return store.site_named(site)
        found = store.site_for((await browser.page()).url)
        if not found:
            raise LookupError('This page is not on a mapped site. Name the site, or teach something here first.')
        return found

    @tool()
    async def site_map(site: str = '', here: bool = False) -> dict:
        """The owner's site maps (Obsidian notes, one folder per site). Without a
        site: every mapped site with its start page, taught target names and
        routines. With a site (e.g. "TradingView"): its targets by page and its
        routines with their steps. here=True: the site of the page on screen.
        Read this before working on a mapped site."""
        if here:
            found = store.site_for((await browser.page()).url)
            if not found:
                return {'site': None}
            site = found['name']
        if not site:
            return {'sites': store.summary()}
        s = store.site_named(site)
        targets = [{'name': t['name'], 'kind': t.get('kind'), 'page': t.get('page'), 'status': t.get('status')}
                   for t in store.site_targets(s)]
        routines = [{'name': r['name'], 'params': r.get('params', []), 'description': r.get('description', ''),
                     'steps': r.get('steps', []), 'last_run': r.get('last_run')} for r in store.routines(s)]
        return {'site': s['name'], 'start_url': s.get('start_url'), 'hosts': s.get('hosts'), 'targets': targets,
                'shortcuts': s.get('shortcuts') or {},
                'routines': routines, 'notes_folder': str(store.folder(s))}

    @tool()
    async def site_rename(site: str, new_name: str = '', start_url: str = '') -> dict:
        """Rename a mapped site (its Obsidian folder) or set its start page, when the owner asks."""
        return store.rename_site(site, new_name, start_url)

    @tool()
    async def site_routine_save(name: str, steps: list, params: list | None = None, description: str = '', site: str = '') -> dict:
        """Save a routine for a mapped site after doing the task once, so it can be
        run again. steps, in order, each one of:
        {"do": "open", "url": "..."}, {"do": "click", "target": "<taught name>"},
        {"do": "type", "target": "<taught name>", "text": "{pair}", "submit": true} (no target:
        types into the focused box, e.g. after a shortcut that opens the search),
        {"do": "key", "key": "Enter"}, {"do": "shortcut", "name": "<saved shortcut>"},
        {"do": "menu_pick", "target": "<taught menu>", "label": "{pair}"},
        {"do": "wait_text", "text": "{pair}"}, {"do": "wait", "seconds": 1},
        {"do": "handoff", "message": "..."}: stop with the setup ready for the owner,
        outlining the order button (on owner-presses-orders sites the Dots never press it).
        Any step may add "expect": text that must show afterwards. params: the
        fill-in names used as {name} (e.g. ["pair"]). Never put secrets in steps."""
        s = await site_of(site)
        params = [p for p in (params or []) if re.fullmatch(r'\w{1,40}', str(p))]
        steps = check_steps(steps, params)
        names = {key(t['name']) for t in store.site_targets(s)}
        unknown = [st['target'] for st in steps if st.get('target') and key(st['target']) not in names]
        if unknown:
            raise LookupError(f'Not taught on {s["name"]}: {", ".join(unknown)}. Teach them first (browser_teach_start).')
        saved = store.save_routine(s, {'name': name.strip()[:80], 'params': params, 'description': description[:500], 'steps': steps})
        return {'saved': saved['name'], 'site': s['name'], 'note': saved['note'], 'steps': len(steps)}

    @tool()
    async def site_routine_run(name: str, values: dict | None = None, site: str = '') -> dict:
        """Run a saved routine on its site, e.g. name "Open pair", values
        {"pair": "EURUSD"}. Opens the site's start page first if the browser is
        elsewhere. Each step finds its element again on the live page and is
        checked; the run stops at the first step that fails and says which."""
        values = {str(k): str(v) for k, v in (values or {}).items()}
        s = await site_of(site)
        routine = store.routine(s, name)
        missing = [p for p in routine.get('params', []) if p not in values]
        if missing:
            raise ValueError(f'Fill in {", ".join(missing)} for "{routine["name"]}".')
        ensure_control()
        page = await browser.page()
        if store.site_for(page.url) is None or store.site_for(page.url)['name'] != s['name']:
            async with browser.lock:
                await page.goto(s['start_url'], wait_until='domcontentloaded', timeout=30000)
                await browser.settle()
        done = []
        for number, step in enumerate(routine['steps'], 1):
            if step['do'] == 'handoff':
                async with browser.lock:
                    page = await browser.page()
                    shown = await page.evaluate(order_guard.SHOW_ORDER_BUTTONS, order_guard.ORDER.pattern)
                    if shown:  # Rest the mouse on the order button: a hover, never a click.
                        await page.mouse.move(shown[0]['x'], shown[0]['y'], steps=12)
                routine['last_run'] = {'at': time.time(), 'result': 'ready for the owner', 'step': number}
                store.save_routine(s, routine)
                return {'routine': routine['name'], 'result': 'ready_for_owner', 'steps_done': len(done),
                        'order_buttons_outlined': len(shown), 'mouse_on': shown[0]['label'] if shown else None,
                        'tell_the_owner': step.get('message') or 'The setup is ready. Review it on the page and press the order button yourself.'}
            try:
                try:
                    await run_step(step, values, s)
                except Exception as error:
                    # The local tools' link to Chrome dropped: reconnect, retry this step once.
                    if not re.search(r'Connection closed|Target (page, context or browser )?(has been )?closed|disconnected', str(error)):
                        raise
                    browser._pw = None
                    browser._reset()
                    await run_step(step, values, s)
            except Exception as error:
                routine['last_run'] = {'at': time.time(), 'result': 'stopped', 'step': number, 'error': str(error)[:300]}
                store.save_routine(s, routine)
                return {'routine': routine['name'], 'result': 'stopped', 'failed_step': number,
                        'step': step, 'error': str(error), 'done': done,
                        'note': 'Nothing after this step was done. Look at the page before trying again.'}
            done.append(number)
        routine['last_run'] = {'at': time.time(), 'result': 'completed'}
        store.save_routine(s, routine)
        snap = await browser.snapshot(max_chars=1500)
        return {'routine': routine['name'], 'result': 'completed', 'steps': len(done), 'url': snap.get('url'), 'page': snap}

    @tool()
    async def site_shortcut_add(name: str, keys: str, description: str = '', site: str = '') -> dict:
        """Save a keyboard shortcut the site offers, e.g. name "Search bar", keys "/"
        or name "Options", keys "o" (Playwright key names; a sequence is
        space-separated, e.g. "g o"; combinations use +, e.g. "Shift+O"). Shortcuts
        are often more reliable than buttons; routines can use {"do": "shortcut"}."""
        if not name.strip() or not keys.strip():
            raise ValueError('Give the shortcut a name and its keys.')
        s = await site_of(site) if site else store.site_for((await browser.page()).url, create=True)
        return {'site': s['name'], 'shortcuts': store.add_shortcut(s, name, keys, description)}

    @tool()
    async def site_shortcut_press(name: str, site: str = '') -> dict:
        """Press a saved site shortcut by name on the page on screen (e.g. "Search bar")."""
        ensure_control()
        s = await site_of(site)
        shortcut = store.shortcut(s, name)
        async with browser.lock:
            page = await browser.page()
            await press_keys(page, shortcut['keys'])
            await browser.settle()
        return {'pressed': shortcut['keys'], 'shortcut': shortcut['name'], 'page': await browser.snapshot(max_chars=1500)}

    @tool()
    async def site_routine_forget(name: str, site: str = '') -> dict:
        """Delete a routine when the owner asks."""
        return {'deleted': store.forget_routine(await site_of(site), name)}

    async def drain(page):
        try:
            await page.evaluate(RECORD)
            events = await page.evaluate('() => { const r = window.__dotsRecord; const e = r ? r.events.splice(0) : []; return e; }')
        except Exception:
            return  # Mid-navigation; the next poll re-arms.
        url = page.url
        for event in events:
            if recording['steps'] and event['do'] == 'type' and recording['steps'][-1].get('do') == 'type' \
                    and recording['steps'][-1].get('descriptor') == event.get('descriptor'):
                recording['steps'][-1].update(text=event['text'], submit=event.get('submit') or recording['steps'][-1].get('submit'))
                continue
            event.pop('at', None)
            event['page'] = page_of(url)
            recording['steps'].append(event)

    @tool()
    async def site_routine_record_start(name: str, fill_ins: dict | None = None) -> dict:
        """Start recording the owner doing a task on this site, to save as a
        routine. fill_ins maps each fill-in to the example the owner will type,
        e.g. {"pair": "EURUSD"}: typed text equal to an example is saved as
        {pair}. The owner takes control and does the task; then finish."""
        async with browser.lock:
            page = await browser.page()
            site = store.site_for(page.url, create=True)
            if site is None:
                raise ValueError('Open the site first (an HTTP(S) page).')
            recording.clear()
            recording.update(name=name.strip()[:80], site=site['name'], fill_ins={str(k): str(v) for k, v in (fill_ins or {}).items() if str(v)},
                             start_url=page.url, steps=[])
            await page.evaluate('() => { delete window.__dotsRecord; }')
            await page.evaluate(RECORD)
        return {'recording': recording['name'], 'site': site['name'], 'start_url': page.url,
                'next': 'Owner: take control and do the task once, then finish recording.'}

    @tool()
    async def site_routine_record_poll() -> dict:
        """Collect the owner's recorded steps so far (also re-arms after a page change)."""
        if not recording:
            return {'recording': None, 'steps': []}
        async with browser.lock:
            await drain(await browser.page())
        return {'recording': recording['name'], 'site': recording['site'],
                'steps': [{'do': s['do'], 'label': (s.get('descriptor') or {}).get('label') or s.get('key'), 'text': s.get('text')} for s in recording['steps']]}

    @tool()
    async def site_routine_record_finish(description: str = '', save: bool = True) -> dict:
        """Stop recording; save the steps as a routine (save=False discards them).
        Clicked elements that match a taught target are saved by its name."""
        if not recording:
            raise LookupError('No routine is being recorded.')
        async with browser.lock:
            page = await browser.page()
            await drain(page)
            await page.evaluate('() => { delete window.__dotsRecord; }')
        name, site_name, fills, steps, start = recording['name'], recording['site'], recording['fill_ins'], recording['steps'], recording['start_url']
        recording.clear()
        if not save:
            return {'discarded': name}
        if not steps:
            raise LookupError('Nothing was recorded: no clicks or typing reached the page.')
        site = store.site_named(site_name)
        taught = store.site_targets(site)
        def same(a, b):
            # Taught by stable attributes (id, test ids) when it has them, else by label.
            if not a or not b or a.get('tag') != b.get('tag'):
                return False
            if b.get('attrs'):
                keys = {x[0] for x in b['attrs']}  # Taught before name/placeholder were kept.
                return [list(x) for x in a.get('attrs', []) if x[0] in keys] == [list(x) for x in b['attrs']]
            return bool(b.get('label')) and a.get('label') == b.get('label')
        out = [{'do': 'open', 'url': start}]
        for step in steps:
            match = next((t for t in taught if t.get('kind') != 'region' and same(step.get('descriptor'), t.get('descriptor'))), None)
            if match:
                step = {k: v for k, v in step.items() if k != 'descriptor'} | {'target': match['name']}
            if step.get('text'):
                for param, example in fills.items():
                    if example and example in step['text']:
                        step['text'] = step['text'].replace(example, '{' + param + '}')
            out.append(step)
        params = sorted({p for s in out for p in FILL.findall(str(s.get('text', '')))})
        saved = store.save_routine(site, {'name': name, 'params': params, 'description': description[:500], 'steps': out})
        return {'saved': saved['name'], 'site': site['name'], 'params': params, 'steps': len(out), 'note': saved['note']}

    return recording
