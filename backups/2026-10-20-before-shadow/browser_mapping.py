"""JEV proposals with owner review; never activates proposed controls."""
import asyncio
import json
import re
import time
import uuid

from jev import select_target
from procedure_memory import page_context


REVIEW = r"""({proposals,describe}) => {
 const desc=eval('('+describe+')');
 const state={name:'JEV mapping review',kind:'mapping_batch',items:proposals.map(p=>({...p,element:p.ref?document.querySelector(`[data-ld-ref="${p.ref}"]`):null,status:'pending'}))};
 window.__dotsTeach=state;
 let index=0,picking=false;
 const panel=document.createElement('div'),outline=document.createElement('div');
 Object.assign(panel.style,{position:'fixed',top:'8px',right:'8px',maxWidth:'340px',padding:'16px',background:'#172554',color:'white',font:'16px sans-serif',zIndex:'2147483647'});
 Object.assign(outline.style,{position:'fixed',border:'3px solid #38bdf8',pointerEvents:'none',zIndex:'2147483646',boxSizing:'border-box'});
 document.documentElement.append(panel,outline);
 const cleanup=()=>{panel.remove();outline.remove();for(const event of ['pointerdown','pointerup','mousedown','mouseup','click'])window.removeEventListener(event,block,true);window.removeEventListener('keydown',key,true);};
 state.cancel=()=>{state.cancelled=true;cleanup();};
 const key=e=>{if(e.key==='Escape'){e.preventDefault();state.cancel();}};
 const equal=(a,b)=>a&&b&&['tag','role','label','attrs'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
 const render=()=>{
   panel.replaceChildren();outline.style.display='none';
   if(index===state.items.length){state.confirmed=true;state.descriptor={label:'Reviewed batch'};panel.textContent='Review complete — NOT SAVED yet. Tell your Dot to save this mapping batch.';return;}
   const p=state.items[index],title=document.createElement('p');
   title.textContent=`${index+1}/${state.items.length}: ${p.name} — ${p.descriptor?.label||'No confident proposal'}`;panel.append(title);
   if(p.element?.isConnected){const r=p.element.getBoundingClientRect();Object.assign(outline.style,{display:'block',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});}
   for(const label of ['Confirm proposal','Choose different button','Reject proposal','Cancel mapping']){
     const b=document.createElement('button');b.textContent=label;b.style.margin='4px';
     b.disabled=label==='Confirm proposal'&&!p.element;
     b.onclick=e=>{if(!e.isTrusted)return;e.stopPropagation();
       if(label==='Cancel mapping'){state.cancel();return;}
       if(label==='Choose different button'){picking=true;panel.textContent='Click the correct control once to mark it. This click will not activate it. Escape cancels.';outline.style.display='none';return;}
       if(label==='Confirm proposal'){
         if(!p.element?.isConnected||!equal(desc(p.element),p.descriptor)){p.element=null;p.descriptor=null;render();return;}
         p.status='confirmed';
       }else p.status='rejected';
       index++;render();
     };panel.append(b);
   }
 };
 const block=e=>{
   if(!e.isTrusted||panel.contains(e.target))return;
   e.preventDefault();e.stopImmediatePropagation();
   if(e.type!=='click'||!picking)return;
   const target=e.target.closest('button,a,[role=button],[role=option],[role=menuitem],input,select,[onclick]')||e.target;
   if(target===document.body||target===document.documentElement)return;
   const p=state.items[index];p.element=target;p.descriptor=desc(target);p.source='owner_corrected';picking=false;render();
 };
 for(const event of ['pointerdown','pointerup','mousedown','mouseup','click'])window.addEventListener(event,block,true);
 window.addEventListener('keydown',key,true);render();
 return {status:'waiting_for_owner',name:state.name,proposals:proposals.map(p=>({name:p.name,label:p.descriptor?.label||null,reason:p.reason||null})),saved:false};
}"""


def label_match(name, candidates):
    """The candidate whose label shares the most words with the target name, when
    one clearly does; used when JEV is not running. The owner still confirms it."""
    words = set(re.findall(r'\w+', name.lower().replace('_', ' '))) - {'button', 'the', 'open', 'control', 'link'}
    scored = sorted(((len(words & set(re.findall(r'\w+', e.get('name', '').lower()))), e) for e in candidates),
                    key=lambda pair: -pair[0])
    if not scored or scored[0][0] == 0 or (len(scored) > 1 and scored[1][0] == scored[0][0]):
        return None
    return scored[0][1]


def register_mapping_tools(tool, browser, store, describe, status_js, reference_image, current_ref):
    @tool()
    async def browser_map_propose(targets: list[str], candidate_refs: list[int] | None = None) -> dict:
        """Propose 1–8 named buttons using JEV, then show sequential owner review.
        Owner confirms, rejects or marks a correction in the browser. No clicks or
        saves are executed. End the turn; call browser_map_finish after owner review.
        Busy pages use label-matched candidates or up to 7 supplied current refs.
        Missing/uncertain candidates require manual correction. Only visible DOM controls."""
        from browser_targets import target_name
        if not 1 <= len(targets) <= 8 or any(not n.strip() or len(n)>160 for n in targets) or len({target_name(n) for n in targets}) != len(targets):
            raise ValueError('Supply 1–8 unique nonempty target names, up to 160 characters each.')
        async with browser.lock:
            page=await browser.page()
            if not page_context(page.url):
                raise ValueError('Open an HTTP(S) page before proposing mappings.')
            status=await page.evaluate(status_js)
            if status['status'] in ('waiting_for_owner','marked_not_confirmed','confirmed_not_saved'):
                raise LookupError('Finish or explicitly cancel the existing teaching session first. Nothing replaced.')
            await browser.snapshot(max_chars=0,max_elements=250)
            elements=[e for e in browser._refs.values() if e.get('inView')]
            if candidate_refs is not None:
                if not 1<=len(candidate_refs)<=7 or len(set(candidate_refs))!=len(candidate_refs) or any(ref not in {e['ref'] for e in elements} for ref in candidate_refs):
                    raise ValueError('Supply 1–7 unique visible current candidate refs.')
                elements=[e for e in elements if e['ref'] in candidate_refs]
            token=uuid.uuid4().hex
            await page.evaluate('(t)=>window.__dotsMapDocument=t',token)
            shot=await page.screenshot()
            proposals=[]
            for name in targets:
                candidates=elements
                if len(candidates)>7:
                    words=set(re.findall(r'\w+',name.lower().replace('_',' ')))-{'button','the','open','control'}
                    candidates=[e for e in elements if words & set(re.findall(r'\w+',e.get('name','').lower()))]
                proposal={'name':name.strip(),'ref':None,'descriptor':None,'source':'jev'}
                picked=None
                if 1<=len(candidates)<=7:
                    try:
                        picked=(await asyncio.to_thread(select_target,name,candidates,shot))['ref']
                    except LookupError as error:
                        proposal['reason']=str(error)
                    except Exception:
                        pass  # JEV not running or unreachable: match by label below.
                if picked is None and not proposal.get('reason'):
                    # Without JEV, the control whose text best matches the name;
                    # the owner confirms, rejects or corrects it in the page.
                    match=label_match(name,candidates or elements)
                    if match:
                        picked=match['ref']
                        proposal.update(source='label_match',reason='Matched by its label (JEV is not running): confirm, or choose a different button.')
                    else:
                        proposal['reason']='No button label matches this name. Choose the correct button in the page.'
                if picked is not None:
                    try:
                        _,locator=await browser.element(picked)
                        await current_ref(locator)
                        proposal.update(ref=picked,descriptor=await locator.evaluate(describe))
                    except LookupError as error:
                        proposal.update(ref=None,descriptor=None,reason=str(error))
                proposals.append(proposal)
            if await browser.page() is not page or await page.evaluate('()=>window.__dotsMapDocument')!=token:
                raise LookupError('Page changed during proposals. No review or save started.')
            return await page.evaluate(REVIEW,{'proposals':proposals,'describe':describe})

    @tool()
    async def browser_map_finish() -> dict:
        """Save only owner-confirmed proposals after the full batch review.
        Revalidates live identities, saves atomically, and reports rejected names.
        Never clicks a proposed button. Existing unique names are updated."""
        from browser_targets import target_name
        read_state="() => {const s=window.__dotsTeach;return s?.kind==='mapping_batch'?{cancelled:s.cancelled,confirmed:s.confirmed,result:s.result,items:s.items.map(p=>({name:p.name,status:p.status,descriptor:p.descriptor,source:p.source}))}:null}"
        # Wait (up to 90 s) for the owner to go through the review in the page,
        # rather than failing at once: an unattended Dot otherwise calls this
        # over and over while the owner is still reviewing.
        deadline=time.time()+90
        while True:
            async with browser.lock:
                state=await (await browser.page()).evaluate(read_state)
            if not state or state.get('cancelled') or state.get('confirmed') or state.get('result') or time.time()>deadline:
                break
            await asyncio.sleep(1)
        async with browser.lock:
            page=await browser.page()
            state=await page.evaluate(read_state)
            if not state or state.get('cancelled'):
                raise LookupError('NOT SAVED: no active mapping batch. Start a proposal review first.')
            if state.get('result'):
                return state['result']
            if not state.get('confirmed'):
                raise LookupError('NOT SAVED: the owner is still reviewing the proposals in the browser (waited 90 s). End the turn and ask them to confirm or reject each one; call this again after.')
            existing=store.list_targets(page.url)
            document_token=await page.evaluate('()=>window.__dotsMapDocument')
            records=[]
            for index,item in enumerate(state['items']):
                if item['status']!='confirmed':
                    continue
                handle=await page.evaluate_handle('(i)=>window.__dotsTeach.items[i].element',index)
                try:
                    element=handle.as_element()
                    if element is None:
                        raise LookupError('Confirmed control disappeared. Cancel and review again.')
                    now=await element.evaluate(describe)
                    if any(now[key]!=item['descriptor'][key] for key in ('tag','role','label','attrs')) or not (now['label'] or now['attrs']):
                        raise LookupError('Confirmed control changed or has no persistent identity. No mappings saved.')
                    await current_ref(element)
                    crop=await reference_image(page,element,'jev-taught-')
                    matches=[r for r in existing if not r.get('elsewhere') and target_name(r['name'])==target_name(item['name']) and r.get('status')!='needs_reteach']
                    if len(matches)>1:
                        raise LookupError('Duplicate saved name; resolve it before saving proposals.')
                    now['kind']='button'
                    records.append({'id':matches[0]['id'] if matches else str(uuid.uuid4()),'url':page.url,'context':page_context(page.url),'name':item['name'],'kind':'button','descriptor':now,'reference_image':crop,'status':'taught_not_executed','source':item['source'],'updated_at':time.time()})
                finally:
                    await handle.dispose()
            if await browser.page() is not page or await page.evaluate('()=>window.__dotsMapDocument')!=document_token or await page.evaluate('()=>!!window.__dotsTeach?.cancelled'):
                raise LookupError('Page or review changed before saving. No mappings saved.')
            for record in records:
                store.save_target(record)
            result={'status':'saved','saved': [{'id':r['id'],'name':r['name']} for r in records],'rejected':[p['name'] for p in state['items'] if p['status']=='rejected'],'clicked':False}
            await page.evaluate('(result)=>{const s=window.__dotsTeach;s.result=result;s.saved=true;s.cancel();s.cancelled=false;}',result)
            return result
