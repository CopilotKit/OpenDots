"""Native browser for Dots: a visible Chrome (or Edge) window driven by Playwright.

Chrome is started as a normal process (sandbox on, no automation flags) with a
local DevTools port, and Playwright attaches to it. A Playwright-launched
browser is flagged as automated, which sites such as Google sign-in reject.

Pages are returned as readable text plus numbered interactive elements, so a
model clicks [ref] numbers instead of guessing pixels. The browser uses its own
persistent profile (logins stay, the owner's normal Chrome is untouched).
Reading, scrolling and following links run freely; typing and clicking
buttons that submit, buy, send, delete or sign in ask the owner first.
"""

from __future__ import annotations

import asyncio
import base64
from browser_geometry import viewport_point
from procedure_memory import ProcedureMemory, page_context
from jev import select_target, check_image
from browser_targets import register_target_tools
from trading_feed import PriceFeed, TradeJournal, asset_key, read_chart
import os
import re
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

PROFILE = Path(os.environ.get("LOCALTOOLS_BROWSER_PROFILE", Path(__file__).parent / "browser-profile"))
CHANNELS = [c for c in os.environ.get("LOCALTOOLS_BROWSER", "chrome,msedge").split(",") if c]
# Local-only DevTools port so OpenDots can stream a live view and relay the
# owner's input into the same browser.
CDP_PORT = int(os.environ.get("LOCALTOOLS_CDP_PORT", "9333"))
# Present while the owner has taken control; agent actions wait for hand-back.
# Asset (ticker) switching on trading pages: the current asset's button, rows in
# the asset list (names like "GBP/JPY OTC +92%") and the list's scroll window.
ASSET_JS = r"""({mode, name, other}) => {
 const norm = s => (s||'').toUpperCase().replace(/[+\-]?\d+(\.\d+)?\s*%/g,'').replace(/[^A-Z0-9]/g,'');
 const want = norm(name);
 const same = t => { const n = norm(t); return n === want || (!want.endsWith('OTC') && n === want + 'OTC'); };
 if (mode === 'same') return same(other);
 const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
   return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
 const text = e => (e.innerText || '').trim().replace(/\s+/g, ' ');
 // A list window, not a full-page wrapper that happens to scroll.
 const scrolls = e => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2 && e.clientHeight < innerHeight * 0.85; };
 const inList = e => { for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) if (scrolls(x)) return true; return false; };
 const asset = t => t.length <= 40 && !/%/.test(t) && (/^[A-Z0-9.]{2,10}\/[A-Z0-9.]{2,10}( OTC)?$/i.test(t) || / OTC$/.test(t));
 const all = Array.from(document.body.querySelectorAll('*')).slice(0, 15000);
 // The row or button to click: a link/button/option ancestor, else the outermost
 // ancestor still showing a pointer cursor (inner text inherits the cursor).
 const clickable = e => {
   for (let x = e, i = 0; x && i < 5; x = x.parentElement, i++) if (x.matches('a,button,[role=button],[role=option],li')) return x;
   let top = e;
   for (let x = e, i = 0; x && i < 5 && getComputedStyle(x).cursor === 'pointer'; x = x.parentElement, i++) top = x;
   return top;
 };
 // A row or tab showing this asset with its payout, e.g. "GBP/JPY OTC +92%".
 const payout = e => { for (let x = e, i = 0; x && i < 4; x = x.parentElement, i++) { const t = text(x); if (/%/.test(t) && same(t)) return true; } return false; };
 const opener = () => {
   const found = all.filter(e => visible(e) && !inList(e) && asset(text(e)) && !Array.from(e.children).some(c => text(c) === text(e)));
   found.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
   return found[0];
 };
 document.querySelectorAll('[data-dots-asset]').forEach(e => e.removeAttribute('data-dots-asset'));
 if (mode === 'opener') { const o = opener(); if (!o) return ''; clickable(o).setAttribute('data-dots-asset', 'opener'); return text(o); }
 if (mode === 'row' || mode === 'tab') {
   const o = opener(), skip = o ? clickable(o) : null;
   const rows = all.filter(e => visible(e) && same(text(e)) && !(skip && (skip === e || skip.contains(e) || e.contains(skip))));
   // Before the list opens, only tabs showing a payout count (not trade history entries).
   const leaves = rows.filter(e => !rows.some(x => x !== e && e.contains(x)))
     .filter(e => payout(e) || (mode === 'row' && inList(e)));
   if (!leaves.length) return {found: false};
   clickable(leaves[0]).setAttribute('data-dots-asset', 'row');
   return {found: true, label: text(leaves[0])};
 }
 const lists = all.filter(e => visible(e) && scrolls(e)).map(e => ({e, n: Array.from(e.querySelectorAll('*')).filter(x => /\//.test(text(x)) && text(x).length < 40).length}))
   .filter(x => x.n >= 3).sort((a, b) => b.n - a.n);
 if (!lists.length) return {seen: [], end: true};
 const list = lists[0].e, box = list.getBoundingClientRect();
 const seen = [...new Set(Array.from(list.querySelectorAll('*')).filter(x => { const r = x.getBoundingClientRect(); return r.height > 1 && r.top >= box.top && r.bottom <= box.bottom && asset(text(x).replace(/\s*[+\-]?\d+(\.\d+)?\s*%.*$/, '')) && !x.children.length; })
   .map(x => text(x)))].slice(0, 30);
 const end = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
 if (mode === 'scroll_top') list.scrollTop = 0; else list.scrollTop += list.clientHeight * 0.8;
 return {seen, end: mode !== 'scroll_top' && end};
}"""

TAKEOVER_FLAG = Path(
    os.environ.get("LOCALTOOLS_TAKEOVER_FILE", Path(__file__).parent / "output" / "browser-takeover.flag")
)
RISKY = re.compile(
    r"\b(buy|pay|purchase|order|checkout|place order|send|post|publish|submit|delete|remove|"
    r"confirm|sign ?in|log ?in|sign ?up|register|subscribe|transfer|donate|accept|agree|install|download|upload|"
    # Trading and money movement need the owner's approval (see POLICY_FILE).
    r"sell|trade|deposit|withdraw|higher|lower|call|put|invest|bet|wager|stake|cash ?out)\b",
    re.I,
)
# Moving money always asks, even on auto-approved sites.
MONEY = re.compile(
    r"\b(deposit|withdraw|transfer|pay|payment|purchase|checkout|cash ?out|donate|top ?up|add funds|card)\b",
    re.I,
)
# {"autoApproveSites": ["pocketoption.com"]}: on these sites the agent may click
# action buttons and fill fields without asking. Read on every action, so edits
# apply immediately.
POLICY_FILE = Path(os.environ.get("LOCALTOOLS_BROWSER_POLICY", Path(__file__).parent / "browser-policy.json"))


def auto_approved(url: str) -> bool:
    import json
    from urllib.parse import urlparse

    try:
        sites = json.loads(POLICY_FILE.read_text(encoding="utf-8")).get("autoApproveSites", [])
    except (OSError, ValueError):
        return False
    host = (urlparse(url).hostname or "").lower()
    return any(host == s.lower() or host.endswith("." + s.lower()) for s in sites)

def expiry_seconds(duration) -> int:
    """'5s', '15 sec', '2m', '2 min', '1h', 'S30', 'M1', '00:01:30', '01:30' or 90 -> seconds."""
    text = str(duration).strip().lower().replace(' ', '')
    if re.fullmatch(r'\d+', text):
        return int(text)
    clock = re.fullmatch(r'(?:(\d{1,2}):)?(\d{1,2}):(\d{2})', text)
    if clock:
        return int(clock.group(1) or 0) * 3600 + int(clock.group(2)) * 60 + int(clock.group(3))
    preset = re.fullmatch(r'([smh])(\d+)', text)  # The site's own labels: S30, M1, H4.
    if preset:
        value, scale = preset.group(2), preset.group(1)
    else:
        unit = re.fullmatch(r'(\d+(?:\.\d+)?)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours)', text)
        if not unit:
            raise ValueError(f'Could not read "{duration}" as a time; use e.g. "5s", "30s", "2m" or "00:01:30".')
        value, scale = unit.group(1), unit.group(2)
    return round(float(value) * {'s': 1, 'm': 60, 'h': 3600}[scale[0]])


# Where OpenDots writes the starting balance of the current trading run, so the
# stake limit can tighten once the account is below it.
STAKE_START_FILE = Path(os.environ.get("LOCALTOOLS_STAKE_START_FILE", Path(__file__).parent / "output" / "stake-start.json"))


def stake_policy() -> dict | None:
    """{"stakeLimit": {"percent": 20, "losingPercent": 10}} in the browser policy:
    the most a single trade may stake, as a percent of the current balance."""
    import json

    try:
        policy = json.loads(POLICY_FILE.read_text(encoding="utf-8")).get("stakeLimit")
    except (OSError, ValueError):
        return None
    return policy if isinstance(policy, dict) and isinstance(policy.get("percent"), (int, float)) else None


def run_start_balance() -> float | None:
    import json

    try:
        data = json.loads(STAKE_START_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    fresh = time.time() * 1000 - float(data.get("updatedAt", 0)) < 24 * 3600 * 1000
    return float(data["start"]) if fresh and isinstance(data.get("start"), (int, float)) else None


# The trading account balance shown on the page (e.g. "QT Demo USD 3.13").
BALANCE_JS = r"""() => {
  const shown = document.querySelector('.js-balance-demo, .js-balance-real, .balance-info-block__balance');
  const text = shown ? shown.innerText : (document.body.innerText.match(/(?:QT Demo|QT Real|Demo account|Real account)\s*(?:USD|EUR|GBP|USDT)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i) || [])[1];
  const value = text ? Number(String(text).replace(/[^\d.]/g, '')) : NaN;
  return Number.isFinite(value) && String(text).trim() ? value : null;
}"""

# Marks visible interactive elements with data-ld-ref and describes them.
SNAPSHOT_JS = r"""
(maxElements) => {
  // Refs stay stable across snapshots for as long as an element exists, so a
  // ref read earlier keeps working after other actions.
  window.__ldNext = window.__ldNext || 1;
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],' +
    '[role=searchbox],[role=textbox],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"]),' +
    '[role=row],[role=gridcell],[role=listitem],[role=treeitem],[jsaction*="click"],[data-action]';
  const visible = e => { const r = e.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom <= 0 || r.top >= innerHeight * 3) return false;
    const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const items = []; const seen = new Set();
  for (const e of document.querySelectorAll(sel)) if (!seen.has(e) && visible(e)) { seen.add(e); items.push(e); }
  // Many apps build buttons from divs, spans or links without href, wired by
  // click listeners (trading BUY/SELL buttons are often <a class="btn"> with no
  // href). Include the outermost element that looks clickable - pointer cursor,
  // any <a>, or a btn/button class - and has no interactive element inside.
  const clickable = e => e.tagName === 'A' ||
    /(^|[\s_-])(btn|button)([\s_-]|$)/i.test(typeof e.className === 'string' ? e.className : '') ||
    getComputedStyle(e).cursor === 'pointer';
  let checked = 0;
  for (const e of document.body.querySelectorAll('*')) {
    if (++checked > 15000) break;
    if (seen.has(e) || e.closest(sel) || e.querySelector(sel) || !visible(e) || !clickable(e)) continue;
    // A link is the real target: skip wrappers around one and parts inside one.
    const parent = e.parentElement;
    if (e.tagName !== 'A' && (e.querySelector('a') || e.closest('a') ||
        (parent && parent !== document.body && clickable(parent)))) continue;
    seen.add(e); items.push(e);
  }
  const inView = e => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
  items.sort((a, b) => Number(inView(b)) - Number(inView(a)));
  const out = [];
  for (const e of items.slice(0, maxElements)) {
    let ref = e.getAttribute('data-ld-ref');
    if (!ref) { ref = String(window.__ldNext++); e.setAttribute('data-ld-ref', ref); }
    const tag = e.tagName.toLowerCase();
    const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') ||
      e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') ||
      e.querySelector('[alt],[aria-label],title')?.getAttribute('alt') ||
      e.querySelector('[aria-label]')?.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ ref: Number(ref), tag, role: e.getAttribute('role') || (e.matches(sel) ? '' : 'clickable'),
      type: e.getAttribute('type') || '', name, href: tag === 'a' ? e.href.slice(0, 120) : undefined,
      inView: inView(e), bounds: (() => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })() });
  }
  const main = document.querySelector('main, article, [role=main]') || document.body;
  return { elements: out, text: (main ? main.innerText : '').replace(/\n{3,}/g, '\n\n') };
}
"""


EXECUTABLES = {"chrome": "chrome.exe", "msedge": "msedge.exe"}
WINDOW = os.environ.get("LOCALTOOLS_BROWSER_SIZE", "1440,900")


def browser_executable() -> str:
    import winreg

    for channel in CHANNELS:
        exe = EXECUTABLES.get(channel, channel)
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                key_path = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe
                with winreg.OpenKey(hive, key_path) as key:
                    return winreg.QueryValue(key, None)
            except OSError:
                continue
    raise RuntimeError("Chrome or Edge is not installed.")


def debugger_up() -> bool:
    import httpx

    try:
        return httpx.get(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1).status_code == 200
    except Exception:
        return False


def launch_chrome(url: str = "about:blank", debug: bool = True) -> subprocess.Popen:
    """Start a normal Chrome window on the Dots' profile (no automation flags)."""
    PROFILE.mkdir(parents=True, exist_ok=True)
    args = [
        browser_executable(),
        f"--user-data-dir={PROFILE}",
        f"--window-size={WINDOW}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if debug:
        args.append(f"--remote-debugging-port={CDP_PORT}")
    return subprocess.Popen(args + [url])


# Boxes of in-view marked elements (CSS pixels) for drawing numbered marks.
MARKS_JS = r"""
() => [...document.querySelectorAll('[data-ld-ref]')].flatMap(e => {
  const r = e.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return [];
  return [{ ref: Number(e.getAttribute('data-ld-ref')), x: r.left, y: r.top, w: r.width, h: r.height }];
})
"""
# A visible cursor that glides to each click, so the owner sees the AI's mouse.
CURSOR_JS = r"""
([x, y]) => {
  let c = document.getElementById('__ld_cursor');
  if (!c) {
    c = document.createElement('div'); c.id = '__ld_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;' +
      'margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,90,54,.35);border:3px solid #ff5a36;' +
      'box-shadow:0 0 0 4px rgba(255,255,255,.7);transition:left .35s ease,top .35s ease;left:50%;top:50%';
    document.documentElement.appendChild(c);
  }
  c.style.left = x + 'px'; c.style.top = y + 'px';
}
"""
# What is at a point (for clicks chosen on the grid).
POINT_JS = r"""
([x, y]) => { const e = document.elementFromPoint(x, y); if (!e) return null;
  const t = e.closest('a,button,[role],input,textarea,select,[onclick],[jsaction]') || e;
  return { tag: t.tagName.toLowerCase(), role: t.getAttribute('role') || '', type: t.getAttribute('type') || '',
    editable: t.matches('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=hidden])')&&!t.readOnly&&!t.disabled||t.isContentEditable,
    clickable: t.matches('a,button,input,select,textarea,canvas,[role=button],[role=option],[role=menuitem],[onclick],[jsaction]')||getComputedStyle(t).cursor==='pointer',
    name: (t.getAttribute('aria-label') || t.innerText || t.value || t.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80) }; }
"""
GRID_COLS, GRID_ROWS = 12, 8
# Model that points at screen targets. Qwen-VL models are trained for GUI grounding
# (benchmark on a dense mock inbox: 7/8 correct vs 4/8 for numbered marks with Gemma).
GROUNDING_MODEL = os.environ.get("LOCALTOOLS_GROUNDING_MODEL", "qwen3-vl:8b")
# Point coordinates arrive normalized to 0-1000 (Qwen-VL convention).


def draw_marks(image, marks, scale):
    """Numbered boxes over each clickable element (high contrast labels)."""
    from PIL import ImageDraw, ImageFont

    image = image.convert("RGB")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arialbd.ttf", max(12, int(13 * scale)))
    except OSError:
        font = ImageFont.load_default()
    for m in marks:
        x0, y0 = m["x"] * scale, m["y"] * scale
        x1, y1 = x0 + m["w"] * scale, y0 + m["h"] * scale
        draw.rectangle([x0, y0, x1, y1], outline=(255, 40, 40), width=2)
        label = str(m["ref"])
        tw, th = draw.textbbox((0, 0), label, font=font)[2:]
        draw.rectangle([x0, y0, x0 + tw + 6, y0 + th + 4], fill=(255, 40, 40))
        draw.text((x0 + 3, y0 + 1), label, fill=(255, 255, 255), font=font)
    return image


def draw_grid(image):
    """Lettered grid (A1..L8) for clicking things without a box."""
    from PIL import ImageDraw, ImageFont

    image = image.convert("RGB")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cw, ch = width / GRID_COLS, height / GRID_ROWS
    try:
        font = ImageFont.truetype("arialbd.ttf", 16)
    except OSError:
        font = ImageFont.load_default()
    for c in range(GRID_COLS):
        for r in range(GRID_ROWS):
            x0, y0 = c * cw, r * ch
            draw.rectangle([x0, y0, x0 + cw, y0 + ch], outline=(0, 120, 255), width=1)
            draw.text((x0 + 4, y0 + 3), f"{chr(65 + c)}{r + 1}", fill=(0, 90, 220), font=font)
    return image


class Browser:
    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._refs: dict[int, dict] = {}
        self.lock = asyncio.Lock()

    async def page(self):
        if self._context is None:
            from playwright.async_api import async_playwright

            if self._pw is None:
                self._pw = await async_playwright().start()
            if not debugger_up():
                launch_chrome()
                deadline = time.time() + 20
                while not debugger_up():
                    if time.time() > deadline:
                        raise RuntimeError(
                            "Chrome did not open its local control port. If the Dots' browser window "
                            "is already open without it (e.g. from 'Sign in normally'), close it and retry."
                        )
                    await asyncio.sleep(0.3)
            # Attach to the normal Chrome process instead of launching an automated one.
            self._browser = await self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
            self._browser.on("disconnected", lambda *_: self._reset())
            self._context = self._browser.contexts[0]
        if self._page is None or self._page.is_closed():
            pages = [p for p in self._context.pages if not p.is_closed()]
            self._page = pages[-1] if pages else await self._context.new_page()
        return self._page

    def _reset(self) -> None:
        self._browser = None
        self._context = None
        self._page = None
        self._refs = {}

    async def snapshot(self, max_chars: int = 5000, max_elements: int = 150) -> dict:
        page = await self.page()
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10_000)
        except Exception:
            pass
        data = await page.evaluate(SNAPSHOT_JS, max_elements)
        self._refs = {e["ref"]: e for e in data["elements"]}
        lines = []
        for e in data["elements"]:
            kind = e["role"] or (f"{e['tag']}[{e['type']}]" if e["type"] else e["tag"])
            extra = f" -> {e['href']}" if e.get("href") else ""
            lines.append(f"[{e['ref']}] {kind}: {e['name'] or '(no label)'}{extra}{'' if e['inView'] else ' (below)'}")
        text = data["text"]
        return {
            "url": page.url,
            "title": await page.title(),
            "tabs": len(self._context.pages),
            "elements": "\n".join(lines),
            "text": text[:max_chars] + ("\n...[truncated, use browser_read for more]" if len(text) > max_chars else ""),
        }

    async def element(self, ref: int):
        page = await self.page()
        locator = page.locator(f'[data-ld-ref="{ref}"]').first
        if await locator.count():
            info = await locator.evaluate(
                r"""e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '',
                type: e.getAttribute('type') || '', name: (e.getAttribute('aria-label') || e.innerText ||
                e.value || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') ||
                e.querySelector('[alt],[aria-label],title')?.getAttribute('alt') ||
                e.querySelector('[aria-label]')?.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80) })"""
            )
            previous = self._refs.get(ref)
            if previous and previous.get('role') == 'clickable' and not info['role']:
                info['role'] = 'clickable'
            if previous and any(previous.get(key, '') != info.get(key, '') for key in ('tag', 'role', 'type', 'name')):
                raise LookupError(f"Element [{ref}] changed since it was observed. Rescan with browser_find or browser_snapshot before acting.")
            self._refs[ref] = {"ref": ref, **info}
            return self._refs[ref], locator
        raise LookupError(
            f"Element [{ref}] is no longer on the page. Use browser_find with the button's text, "
            "or browser_snapshot, to get a current ref."
        )

    async def highlight(self, locator) -> None:
        """Outline the element briefly so the owner sees what the agent targets."""
        try:
            await locator.evaluate(
                """el => { const old = el.style.outline; el.style.outline = '3px solid #ff5a36';
                el.style.outlineOffset = '2px'; setTimeout(() => { el.style.outline = old; }, 1200); }"""
            )
            await asyncio.sleep(0.35)
        except Exception:
            pass

    async def settle(self) -> None:
        page = await self.page()
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass
        await asyncio.sleep(0.6)


def register(
    tool: Callable,
    confirm: Callable[[str], None],
    save_image: Callable[[Any, str], str],
    vision: Callable[..., str] | None = None,
) -> None:
    browser = Browser()
    memory = ProcedureMemory(Path(__file__).parent.parent / 'data' / 'browser-procedures.sqlite')
    recording = None
    recording_failed = False
    # page URL -> {'value': number last typed into a field there, 'field': that field}
    typed_amounts = {}

    @tool()
    async def browser_procedure_start(name: str, objective: str) -> dict:
        """Start a new version of a browser procedure. Records subsequent actions automatically.
        Describe the procedure, not secrets or typed values. Supply expected_text on actions
        to verify a newly visible exact label. Existing versions are preserved. No actions replay."""
        nonlocal recording, recording_failed
        async with browser.lock:
            if recording:
                raise ValueError('Finish the active procedure before starting another')
            value = memory.begin((await browser.page()).url, name, objective)
            recording = value['id']
            recording_failed = False
            return value

    @tool()
    async def browser_procedure_finish() -> dict:
        """Finish recording. Only steps with actual passing UI checks count as verified.
        Unchecked or failed steps leave the procedure needs_review, never verified."""
        nonlocal recording
        async with browser.lock:
            if not recording:
                raise ValueError('No active procedure recording')
            value = memory.finish(recording)
            if recording_failed:
                value['status'] = 'needs_review'
                value['recording_error'] = 'One or more action records could not be saved. This version is incomplete.'
                memory.save(value)
            recording = None
            return value

    @tool()
    async def browser_procedure_recall() -> dict:
        """Recall structured procedures for the current origin and page path.
        Treat stored targets and geometry as hints. Reacquire targets and verify outcomes;
        memory is not authorization and does not execute any actions."""
        async with browser.lock:
            return {'procedures': memory.recall((await browser.page()).url), 'active_recording': recording}

    @tool()
    async def browser_procedure_forget(procedure_id: str) -> dict:
        """Delete a saved procedure when the owner requests forgetting it."""
        nonlocal recording
        async with browser.lock:
            deleted = memory.delete(procedure_id)
            if recording == procedure_id:
                recording = None
            return {'deleted': deleted}

    # Live prices from the page's own data feed (read-only), and the trade journal.
    feed = PriceFeed()
    journal = TradeJournal(Path(__file__).parent.parent / 'data' / 'trade-journal.sqlite')
    watching = {'page': None, 'period': 15}

    async def watch_feed(page) -> None:
        if watching['page'] is page:
            return
        watching['page'] = page

        def frame(event):
            response = event.get('response') or {}
            data = response.get('payloadData') or ''
            if response.get('opcode') == 2:
                try:
                    data = base64.b64decode(data).decode('utf-8', 'replace')
                except ValueError:
                    return
            feed.add_frame(data)

        try:
            session = await page.context.new_cdp_session(page)
            session.on('Network.webSocketFrameReceived', frame)
            await session.send('Network.enable')
        except Exception:
            watching['page'] = None  # Try again on the next action.

    async def current_asset(page) -> str:
        shown = await page.evaluate(ASSET_JS, {'mode': 'opener', 'name': ''})
        await page.evaluate("() => document.querySelectorAll('[data-dots-asset]').forEach(e => e.removeAttribute('data-dots-asset'))")
        if shown and asset_key(shown) in feed.ticks:
            return asset_key(shown)
        # Otherwise the asset with the newest price.
        live = sorted(feed.ticks, key=lambda k: feed.ticks[k][-1][0] if feed.ticks[k] else 0, reverse=True)
        return live[0] if live else asset_key(shown or '')

    DIRECTION = re.compile(r'^\s*(buy|higher|call|up|sell|lower|put|down)\b', re.I)

    async def journal_trade(name: str) -> None:
        """Record a placed BUY/SELL with its setup; never stops a trade."""
        found = DIRECTION.match(name or '')
        if not found:
            return
        try:
            page = await browser.page()
            key = await current_asset(page)
            last = feed.last(key)
            if not last:
                return
            expiry = await page.evaluate("() => (document.querySelector('.block--expiration-inputs .value__val') || {}).innerText || ''")
            boxes = await amount_fields(page)
            stake = number(boxes[0]['value']) if len(boxes) == 1 else None
            setup = read_chart(feed, key, watching['period']).get('setup', {})
            journal.record(feed.names.get(key, key), 'buy' if found.group(1).lower() in ('buy', 'higher', 'call', 'up') else 'sell',
                           stake, expiry_seconds(expiry) if re.fullmatch(r'\d\d:\d\d:\d\d', expiry.strip()) else None,
                           last[0], last[1], {**setup, 'candle_s': watching['period']})
        except Exception:
            pass

    # Money never moves through the Dots: deposits, payments, top-ups and
    # withdrawals are refused in every mode. Unattended mode answers "allowed"
    # to every confirmation, so asking is not enough (it let a run click
    # "Continue and pay $4.54" in a TOP UP form).
    MONEY_PLACE = re.compile(r'deposit|withdraw|cashier|payment|top-?up|checkout|billing', re.I)
    IN_MONEY_PLACE = r"""e => { const bad = /deposit|withdraw|cashier|payment|top-?up|checkout|billing/i;
      const link = e.closest('a'); if (link && bad.test(link.getAttribute('href') || '')) return true;
      for (let x = e; x && x !== document.body; x = x.parentElement) if (bad.test(String(x.className || ''))) return true;
      return false; }"""

    def money_refusal(name: str) -> PermissionError:
        return PermissionError(
            f'No action was taken: "{name}" moves money (deposit, payment, top up or withdrawal). '
            'The Dots never do this, in any mode. Leave it to the owner and go back to the trading page.')

    async def money_guard(name: str, locator=None, point=None) -> None:
        if MONEY.search(name or ''):
            raise money_refusal(name)
        try:
            if locator is not None:
                inside = await locator.evaluate(IN_MONEY_PLACE)
            elif point is not None:
                inside = await (await browser.page()).evaluate(
                    f'([x, y]) => {{ const e = document.elementFromPoint(x, y); return !!e && ({IN_MONEY_PLACE})(e); }}', point)
            else:
                inside = False
        except Exception:
            inside = False
        if inside:
            raise money_refusal(name or 'this control')

    def trade_target(name: str, amount) -> None:
        """A click that carries a stake is meant to place a trade: it must hit a
        BUY/SELL style button, not whatever now has that ref (POCKET FRIENDS, a promo)."""
        if amount is None or not str(amount).strip():
            return
        if not DIRECTION.match(name or '') and not re.search(r'double', name or '', re.I):
            raise LookupError(
                f'No click was made: [{name or "?"}] is not a BUY or SELL button, but a stake was given, so this '
                'was meant to be a trade. Get the current ref with browser_find("BUY") or browser_find("SELL").')

    async def ask(action: str) -> None:
        await asyncio.to_thread(confirm, action)

    def ensure_control() -> None:
        if TAKEOVER_FLAG.exists():
            raise PermissionError(
                "The owner has taken control of the browser. Do not act; tell them you will "
                "continue once they hand control back, or ask what they want."
            )

    async def act(work: Callable[[], Awaitable[Any]], max_chars: int = 3000, action=None, expected_text: str = '') -> dict:
        nonlocal recording_failed
        ensure_control()
        async with browser.lock:
            before = await browser.page()
            await watch_feed(before)
            if await before.evaluate('() => !!(window.__dotsTeach && !window.__dotsTeach.cancelled && !window.__dotsTeach.saved)'):
                raise PermissionError('Teaching is pending owner confirmation. Finish or cancel teaching before automated actions.')
            context = page_context(before.url)
            viewport = await before.evaluate('() => ({width: innerWidth, height: innerHeight})') if recording else None
            async def visible(page):
                if not expected_text:
                    return False
                labels = page.get_by_text(expected_text, exact=True)
                return any([await labels.nth(i).is_visible() for i in range(min(await labels.count(), 30))])
            existed = await visible(before) if recording else False
            step = {'page_before': context, 'action': (action or {}).get('kind', 'browser_action'), 'target': (action or {}).get('target', {}), 'viewport': viewport,
                    'expected': {'new_visible_text': expected_text[:500]} if expected_text else None, 'verification': 'unchecked'}
            try:
                result = await work()
                await browser.settle()
                snap = await browser.snapshot(max_chars=max_chars)
                if context and action and action.get('kind', '').startswith('visual_') and not page_context(snap.get('url', '')):
                    raise RuntimeError('Action outcome is uncertain: the browser changed to a blank/internal page. Stop and inspect; do not repeat the action.')
            except Exception:
                if recording:
                    step.update(verification='failed', evidence='Action or observation failed; outcome may be uncertain. Do not replay without checking.')
                    try:
                        memory.append(recording, step)
                    except Exception:
                        recording_failed = True  # Preserve the original action failure.
                raise
            if recording:
                step['page_after'] = page_context(snap['url'])
                if expected_text:
                    try:
                        passed = not existed and await visible(await browser.page())
                    except Exception:
                        passed = False
                    step.update(verification='passed' if passed else 'failed', evidence='Expected exact label became visible.' if passed else 'Expected label was already visible or did not appear; effect not established.')
                else:
                    step['evidence'] = 'Tool returned; no explicit outcome check supplied.'
                try:
                    memory.append(recording, step)
                    result = {**(result or {}), 'procedure_memory': {'id': recording, 'verification': step['verification'], 'evidence': step['evidence']}}
                except Exception:
                    recording_failed = True
                    result = {**(result or {}), 'procedure_memory': {'error': 'Action returned but memory could not be saved. Do not repeat the action to repair memory.'}}
            return {**(result or {}), **snap}

    recall_target_name = register_target_tools(tool, browser, save_image, ensure_control)

    @tool()
    async def browser_open(url: str, new_tab: bool = False) -> dict:
        """Open a web page in the Dots' own browser window and return its text and numbered elements."""
        url = url.strip()
        if not re.match(r"^[a-z]+://", url, re.I):
            url = "https://" + url
        if MONEY_PLACE.search(url.split('?')[0]):
            raise money_refusal(url)

        async def work():
            page = await browser.page()
            # Reuse a blank tab instead of leaving it behind.
            if new_tab and page.url != "about:blank":
                page = await browser._context.new_page()
                browser._page = page
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)

        return await act(work)

    @tool()
    async def browser_snapshot(max_chars: int = 5000) -> dict:
        """Re-read the current page: URL, title, visible text and numbered interactive elements [ref]."""
        async with browser.lock:
            return await browser.snapshot(max_chars=max_chars if max_chars > 0 else 5000)

    async def look(target: str):
        """Find a target on screen: a grounding model points at it; numbered
        marks and then a lettered grid are fallbacks."""
        from PIL import Image
        import io

        page = await browser.page()
        await browser.snapshot(max_chars=0, max_elements=250)
        if not page_context(page.url):
            raise LookupError('No active website is loaded. Visual actions on blank/internal pages are disabled.')
        document_token = await page.evaluate('(token) => {window.__dotsVisualDocument ??= token;return window.__dotsVisualDocument}', uuid.uuid4().hex)
        page_url = page.url
        remembered = await recall_target_name(target)
        if remembered:
            box = remembered['bounds']
            return {'ref': remembered['ref'], 'x': box['x'] + box['width']/2, 'y': box['y'] + box['height']/2, 'image': None, 'how': 'owner_taught_memory', 'document_token': document_token, 'page_url': page_url}
        marks = await page.evaluate(MARKS_JS)
        shot = Image.open(io.BytesIO(await page.screenshot()))
        viewport = await page.evaluate("() => [innerWidth, innerHeight]")
        scale = shot.width / max(1, viewport[0])
        pointed = await asyncio.to_thread(
            vision,
            shot,
            f"Point to: {target}. Answer only with JSON "
            '{"point": [x, y]} using coordinates normalized to 0-1000 for this image.',
            False,
            1600,
            GROUNDING_MODEL,
        )
        point = viewport_point(pointed, viewport[0], viewport[1])
        if point is not None:
            x, y = point
            # Report the marked element under the point (smallest box), if any.
            inside = [m for m in marks if m["x"] <= x <= m["x"] + m["w"] and m["y"] <= y <= m["y"] + m["h"]]
            ref = min(inside, key=lambda m: m["w"] * m["h"])["ref"] if inside else None
            from PIL import ImageDraw

            seen = shot.convert("RGB")
            dot = ImageDraw.Draw(seen)
            px, py = x * scale, y * scale
            dot.ellipse([px - 12, py - 12, px + 12, py + 12], outline=(255, 40, 40), width=4)
            return {"ref": ref, "x": x, "y": y, "image": save_image(seen, "pointed"), "how": "pointed", "document_token": document_token, "page_url": page_url}
        marked = draw_marks(shot, marks, scale)
        path = save_image(marked, "marked")
        answer = await asyncio.to_thread(
            vision,
            marked,
            "This is a screenshot of a web page. Red numbered boxes mark clickable things. "
            f"Which box is: {target}? Reply with only the box number, or 0 if no box fits.",
            False,
        )
        number = int(re.search(r"\d+", answer).group()) if re.search(r"\d+", answer) else 0
        known = {m["ref"]: m for m in marks}
        if number in known:
            m = known[number]
            return {"ref": number, "x": m["x"] + m["w"] / 2, "y": m["y"] + m["h"] / 2, "image": path, "how": "marks", "document_token": document_token, "page_url": page_url}
        # Fallback: a lettered grid for things without a box.
        gridded = draw_grid(shot)
        cell = await asyncio.to_thread(
            vision,
            gridded,
            "This is a screenshot of a web page with a blue lettered grid. "
            f"Which grid cell contains: {target}? Reply with only the cell label like C4, or NONE.",
            False,
        )
        found = re.search(r"\b([A-L])\s*([1-8])\b", cell.upper())
        if not found:
            raise LookupError(f"Could not find '{target}' on the screen. Try describing it differently or scroll.")
        col, row = ord(found.group(1)) - 65, int(found.group(2)) - 1
        return {
            "ref": None,
            "x": (col + 0.5) * viewport[0] / GRID_COLS,
            "y": (row + 0.5) * viewport[1] / GRID_ROWS,
            "image": save_image(gridded, "grid"),
            "cell": found.group(1) + found.group(2),
            "document_token": document_token,
            "page_url": page_url,
        }

    async def mouse_to(x: float, y: float):
        page = await browser.page()
        await page.evaluate(CURSOR_JS, [x, y])
        await page.mouse.move(x, y, steps=12)
        await asyncio.sleep(0.4)

    async def verify_spot(page, spot, expected):
        if page.url != spot.get('page_url') or await page.evaluate('() => window.__dotsVisualDocument') != spot.get('document_token'):
            raise LookupError('The page navigated or reloaded after the screenshot. Reacquire the target; no action was issued.')
        if await browser.page() is not page:
            raise LookupError('The active page changed. Rescan the target before acting.')
        current = await page.evaluate(POINT_JS, [spot['x'], spot['y']])
        if not current or current != expected:
            raise LookupError('The visual target changed or moved. Rescan with browser_find or a fresh screenshot before acting.')

    @tool()
    async def browser_visual_click(target: str, expected_text: str = '') -> dict:
        """Look at the page and click something described in plain words, like a person with a mouse:
        e.g. 'the first email in the inbox', 'the blue Sign up button', 'the search icon'.
        Use this when browser_find cannot locate it or the page is a complex web app."""
        ensure_control()
        if vision is None:
            raise RuntimeError("No vision model is configured for look-and-click.")
        async with browser.lock:
            spot = await look(target)
            page = await browser.page()
            info = await page.evaluate(POINT_JS, [spot["x"], spot["y"]]) or {"tag": "", "role": "", "name": ""}
            if info.get('tag') in ('', 'body', 'html') or not info.get('clickable'):
                raise LookupError('Vision selected a non-interactive area. No click was issued; inspect the screenshot or teach the correct target.')
        name = info.get("name") or ""
        is_link = info.get("tag") == "a" or info.get("role") == "link"
        await money_guard(name, point=[spot["x"], spot["y"]])
        if re.search(r'\b(buy|sell|higher|lower|call|put)\b', target, re.I) and not DIRECTION.match(name):
            raise LookupError(f'Vision picked "{name or "an unlabelled control"}", not a BUY or SELL button; no click was made. '
                              'Use browser_find("BUY") or browser_find("SELL") and browser_click with its ref.')
        if not is_link:
            await confirm_amount(page.url, name)
            await stake_limit(name)
        if not is_link and RISKY.search(name):
            await ask(f"Click \"{name or target}\" on {page.url}")

        async def work():
            await verify_spot(page, spot, info)
            await mouse_to(spot["x"], spot["y"])
            await verify_spot(page, spot, info)
            await page.mouse.click(spot["x"], spot["y"])
            where = (
                f"grid {spot.get('cell')}"
                if spot.get("cell")
                else f"[{spot['ref']}]"
                if spot["ref"] is not None
                else f"point ({round(spot['x'])}, {round(spot['y'])})"
            )
            return {"clicked": f"{where} {name or target}", "looked_at": spot["image"]}

        result = await act(work, action={'kind': 'visual_click', 'target': {'label': target, 'observed_label': name, 'last_point': {'x': spot['x'], 'y': spot['y']}, 'coordinate_space': 'viewport_css_pixels'}}, expected_text=expected_text)
        if not is_link:
            await journal_trade(name)
        return result

    @tool()
    async def browser_visual_type(target: str, text: str, submit: bool = False, expected_text: str = '') -> dict:
        """Look at the page, click the field described in plain words (e.g. 'the To field', 'the search bar'),
        and type text into it like a keyboard. submit=true presses Enter after."""
        ensure_control()
        if vision is None:
            raise RuntimeError("No vision model is configured for look-and-click.")
        async with browser.lock:
            spot = await look(target)
            page = await browser.page()
            info = await page.evaluate(POINT_JS, [spot["x"], spot["y"]]) or {"type": "", "role": "", "name": ""}
            if not info.get('editable'):
                raise LookupError('Vision did not select an editable field. No typing was issued.')
        name = info.get("name") or target
        is_search = info.get("type") == "search" or info.get("role") in ("searchbox", "combobox") or re.search(
            r"search|query|find", name, re.I
        )
        if info.get("type") == "password":
            await ask(f"Type a password into \"{name}\" on {page.url}")
        elif not is_search:
            shown = text if len(text) <= 120 else text[:120] + "..."
            await ask(f"Type into \"{name}\"{' and press Enter' if submit else ''}:\n\"{shown}\"")

        async def work():
            await verify_spot(page, spot, info)
            await mouse_to(spot["x"], spot["y"])
            await verify_spot(page, spot, info)
            await page.mouse.click(spot["x"], spot["y"])
            # Replace what is there, like browser_type: typing onto an amount of
            # 60 made "6060", which the trading site capped at the whole balance.
            await page.keyboard.press("Control+A")
            await page.keyboard.press("Delete")
            await page.keyboard.type(text, delay=15)
            field = (await page.evaluate_handle("() => document.activeElement")).as_element()
            if submit:
                await page.keyboard.press("Enter")
            shows = await read_back(page.url, field, text)
            return {"typed_into": name, "looked_at": spot["image"], **({"field_shows": shows} if shows is not None else {})}

        return await act(work, action={'kind': 'visual_type', 'target': {'label': target, 'input': '<runtime value, not stored>', 'submit': submit}}, expected_text=expected_text)

    @tool()
    async def browser_find(text: str, max_results: int = 10) -> dict:
        """Find clickable elements or fields whose label contains text (e.g. 'Search', 'Next', 'Email').
        Returns their [ref] numbers for browser_click / browser_type. Prefer this over guessing refs."""
        async with browser.lock:
            await browser.snapshot(max_chars=0, max_elements=400)
            remembered = await recall_target_name(text)
            if remembered:
                return {'query': text, 'coordinate_space': 'viewport_css_pixels', 'elements': [{'ref': remembered['ref'], 'name': remembered['label'], 'bounds': remembered['bounds'], 'inView': True}], 'matches': [f"[{remembered['ref']}] {remembered['label']}"], 'memory': remembered}
            needle = (text or "").strip().lower()
            matches = [
                e for e in browser._refs.values()
                if needle and (needle in (e.get("name") or "").lower() or needle in (e.get("href") or "").lower())
            ]
            if re.search(r'\b(amount|stake|bet|wager|investment|trade size|sum)\b', needle):
                # Stake boxes show only their number; a promo link whose address
                # contains "amount=" is not the amount field.
                boxes = [e for e in browser._refs.values() if e.get('tag') == 'input' and number(e.get('name') or '') is not None]
                matches = boxes + [e for e in matches if e not in boxes and e.get('tag') != 'a']
            limit = max_results if max_results > 0 else 10
            return {
                "query": text,
                "coordinate_space": "viewport_css_pixels",
                "elements": [{"ref": e["ref"], "name": e["name"], "bounds": e.get("bounds"), "inView": e.get("inView")} for e in matches[:limit]],
                "matches": [
                    f"[{e['ref']}] {e['role'] or e['tag']}: {e['name'] or '(no label)'}"
                    + ("" if e.get("inView", True) else " (below)")
                    for e in matches[:limit]
                ],
                "hint": "" if matches else "Nothing matched; try a shorter word, scroll, or take browser_screenshot.",
            }

    @tool()
    async def browser_jev_check(expectation: str) -> dict:
        """Assess one visible UI expectation as yes/no/uncertain using local JEV.
        Read-only model assessment of a fresh screenshot; not a numeric measurement,
        action trigger, or automatic workflow acceptance."""
        async with browser.lock:
            page = await browser.page()
            url = page.url
            captured_at = datetime.now().isoformat()
            shot = await page.screenshot()
            result = await asyncio.to_thread(check_image, expectation, shot)
            if await browser.page() is not page or page.url != url:
                raise LookupError('Page changed during assessment. Inspect the current page.')
            return {**result, 'expectation': expectation, 'captured_at': captured_at,
                    'scope': 'Screenshot at capture time; live content may have changed.'}

    @tool()
    async def browser_jev_find(target: str, use_image: bool = False, candidate_refs: list[int] | None = None) -> dict:
        """Ask local JEV to select a current visible browser element. Does not click.
        Text controls need no screenshot; use_image adds a fresh screenshot for visual ambiguity.
        Visual JEV always needs an image and at most 7 candidates; supply candidate_refs
        from a current browser_find/snapshot on busy pages. Use the returned ref with
        browser_click/type. An error selects nothing."""
        async with browser.lock:
            page = await browser.page()
            await browser.snapshot(max_chars=0, max_elements=250)
            # A document token prevents accepting a result across navigation/reload.
            token = await page.evaluate("(token) => { window.__dotsJevDocument ??= token; return window.__dotsJevDocument; }", uuid.uuid4().hex)
            elements = list(browser._refs.values())
            remembered = await recall_target_name(target)
            if remembered:
                if candidate_refs is not None and remembered['ref'] not in candidate_refs:
                    raise LookupError('Supplied candidates exclude the remembered target. Reacquire current references.')
                info, _ = await browser.element(remembered['ref'])
                elements = [{**info, 'inView': True, 'bounds': remembered['bounds']}]
                target = remembered['label'] or target
            if candidate_refs is not None:
                if not candidate_refs or len(set(candidate_refs)) != len(candidate_refs) or any(ref not in browser._refs for ref in candidate_refs):
                    raise ValueError('candidate_refs must contain unique current browser references.')
                elements = [e for e in elements if e['ref'] in candidate_refs]
            shot = await page.screenshot() if use_image or os.environ.get('LOCALTOOLS_JEV_BACKEND') == 'visual-jev' else None
            result = await asyncio.to_thread(select_target, target, elements, shot)
            if await browser.page() is not page or await page.evaluate('() => window.__dotsJevDocument') != token:
                raise LookupError('Page changed during JEV selection. Reacquire the target.')
            _, locator = await browser.element(result['ref'])
            if not await locator.is_visible() or not await locator.is_enabled():
                raise LookupError('Selected target is no longer visible or enabled.')
            if remembered:
                refreshed = await recall_target_name(remembered['taught_name'])
                if refreshed['ref'] != result['ref']:
                    raise LookupError('Remembered target changed during JEV selection. Reacquire it.')
            return {**result, 'bounds': await locator.bounding_box(), 'clicked': False, 'memory': remembered}

    @tool()
    async def browser_read(start: int = 0, max_chars: int = 15000) -> dict:
        """Read more of the current page's text (use start to page through long articles)."""
        async with browser.lock:
            page = await browser.page()
            text = await page.evaluate("() => document.body.innerText")
            limit = max_chars if max_chars > 0 else 15000
            return {"url": page.url, "length": len(text), "start": start, "text": text[start:start + limit]}

    @tool()
    async def browser_click(ref: int, expected_text: str = '', amount: float | str | None = None) -> dict:
        """Click element [ref] from the latest snapshot. Existing confirmations apply.
        During procedure recording, expected_text is an exact label that should newly
        become visible after the click. A returned click alone is not a verified outcome.
        amount=12 first puts 12 in the page's amount box and confirms the box shows it, then clicks."""
        ensure_control()
        info, locator = await browser.element(ref)
        url = (await browser.page()).url
        await money_guard(info["name"] or "", locator)
        trade_target(info["name"] or "", amount)
        await apply_amount(amount, url, info["name"] or "")
        if not (info["tag"] == "a" or info["role"] == "link"):
            await confirm_amount(url, info["name"] or "")
            await stake_limit(info["name"] or "")
        name = info["name"] or ""
        is_link = info["tag"] == "a" or info["role"] == "link"
        if not is_link and RISKY.search(name) and not auto_approved(url):
            await ask(f"Click \"{name}\" on {url}")

        async def work():
            await browser.element(ref)
            await locator.scroll_into_view_if_needed(timeout=5000)
            await browser.highlight(locator)
            await locator.click(timeout=10_000)
            return {"clicked": f"[{ref}] {info['name']}"}

        result = await act(work, action={'kind': 'click', 'target': {'label': name, 'tag': info['tag'], 'role': info['role'], 'bounds_hint': await locator.bounding_box(), 'coordinate_space': 'viewport_css_pixels'}}, expected_text=expected_text)
        if not is_link:
            await journal_trade(name)
        return result

    def number(value):
        try:
            return round(float(re.sub(r'[\s$€£,]', '', str(value))), 2)
        except ValueError:
            return None

    async def amount_fields(page):
        """Visible number entry boxes on the page (a trading stake box shows a
        number and often has no label), marked so they can be filled. Boxes in
        deposit or withdrawal forms are never offered; when one box sits under
        an "Amount" (stake, bet, investment) label, only that one is."""
        return await page.evaluate(r"""() => {
          document.querySelectorAll('[data-dots-amount]').forEach(e => e.removeAttribute('data-dots-amount'));
          const up = (e, n = 5) => { const out = []; for (let x = e.parentElement; x && out.length < n; x = x.parentElement) out.push(x); return out; };
          const money = /deposit|withdraw|cashier|payment|top-?up|card/i;
          const label = /^(amount|stake|bet|investment|trade amount|bet amount)$/i;
          const boxes = Array.from(document.querySelectorAll('input')).filter(e => {
            const r = e.getBoundingClientRect(), s = getComputedStyle(e);
            return ['', 'text', 'number', 'tel'].includes((e.getAttribute('type') || '').toLowerCase()) && !e.disabled && !e.readOnly
              && r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'
              && /^\s*[$€£]?\s*\d[\d,]*(\.\d+)?\s*$/.test(e.value)
              && !up(e, 8).some(x => money.test(String(x.className || '')));
          });
          const labelled = boxes.filter(e => up(e, 4).some(x => Array.from(x.children).some(c => !c.querySelector('input') && label.test((c.innerText || '').trim()))));
          return (labelled.length === 1 ? labelled : boxes).map((e, i) => { e.setAttribute('data-dots-amount', String(i)); return {i, value: e.value, ref: Number(e.getAttribute('data-ld-ref')) || null}; });
        }""")

    async def stake_limit(name: str, stake: float | None = None) -> None:
        """Preservation: refuse a trade whose stake is more than the allowed share
        of the current balance (smaller once the account is below the run's start)."""
        policy = stake_policy()
        if not policy or not RISKY.search(name or ''):
            return
        page = await browser.page()
        balance = await page.evaluate(BALANCE_JS)
        if balance is None:
            return  # Not a trading page with a readable balance.
        if stake is None:
            record = typed_amounts.get(page.url)
            try:
                shown = await field_value(record['field']) if record else None
            except Exception:
                shown = None
            if shown is None:
                boxes = await amount_fields(page)
                shown = boxes[0]['value'] if len(boxes) == 1 else None
            stake = number(shown) if shown is not None else None
            if stake is None:
                return
        start = run_start_balance()
        losing = start is not None and balance < start and isinstance(policy.get('losingPercent'), (int, float))
        percent = policy['losingPercent'] if losing else policy['percent']
        cap = int(balance * percent) / 100  # Rounded down to the cent.
        if stake > cap + 1e-9:
            raise ValueError(
                f'No trade was placed: a ${stake:g} stake is more than {percent:g}% of the ${balance:,.2f} balance'
                + (f" (below the run's ${start:,.2f} start, so the smaller limit applies)" if losing else '')
                + f'. Stake at most ${cap:.2f}.'
                + (' That is below the usual $1 minimum: stop trading and reply TASK FAILED with the balance.' if cap < 1 else '')
            )

    async def apply_amount(amount, url: str, name: str = '') -> None:
        """Models pass the stake with the click. Put it in the amount box, confirm
        the box shows it, and only then let the click go ahead; never trade at
        whatever stake happened to be in the box."""
        if amount is None or not str(amount).strip():
            return
        wanted = number(amount)
        if wanted is None:
            raise ValueError(f'No click was made: "{amount}" is not a number.')
        record = typed_amounts.get(url)
        if record and record.get('value') == wanted:
            return  # Already typed; confirm_amount re-checks the box before the click.
        await stake_limit(name, wanted)  # Before the box is changed.
        page = await browser.page()
        field = None
        try:
            taught = await recall_target_name('Amount field')
        except LookupError:
            taught = None
        if taught:
            _, locator = await browser.element(taught['ref'])
            field = await locator.element_handle()
        else:
            boxes = await amount_fields(page)
            if len(boxes) == 1:
                field = await page.locator('[data-dots-amount="0"]').first.element_handle()
            else:
                found = ', '.join(f'[{b["ref"]}] showing {b["value"]}' if b['ref'] else f'a box showing {b["value"]}' for b in boxes)
                raise ValueError(
                    'No click was made: could not tell which box is the amount field '
                    f'({found or "no number box is visible"}). Type the amount with browser_type into the box '
                    'that shows the current stake, or teach that box once as "Amount field".'
                )
        await field.fill(f'{wanted:g}', timeout=5000)
        await read_back(url, field, f'{wanted:g}')

    async def field_value(field):
        return await field.evaluate("e => ('value' in e ? e.value : e.innerText) || ''")

    async def read_back(url: str, field, text: str):
        """After typing a number, what the field really shows; an error when it
        is not the number typed (sites cap, round or append)."""
        if number(text) is None or field is None:
            return None
        typed_amounts[url] = {'value': number(text), 'field': field}
        await asyncio.sleep(0.4)  # Let the site reformat or cap the entry.
        try:
            shows = str(await field_value(field)).strip()
        except Exception:
            return None  # The field was replaced; confirm_amount checks again before a trade.
        if number(shows) != number(text):
            raise ValueError(
                f'The field now shows "{shows}", not {text} (the site may have capped, rounded or appended to it). '
                'Nothing was traded. Type the amount again with browser_type, which replaces the field, '
                'and do not trade until the field shows the amount you want.'
            )
        return shows

    async def confirm_amount(url: str, name: str) -> None:
        """Before a trade button, check the amount field still shows the number
        typed there; a wrong stake (such as the whole balance) is never sent."""
        record = typed_amounts.get(url)
        if not record or not RISKY.search(name or ''):
            return
        try:
            shows = str(await field_value(record['field'])).strip()
        except Exception:
            # The site re-rendered the field; find it again by what it held.
            return
        if number(shows) != record['value']:
            raise ValueError(
                f'No click was made: the amount field shows "{shows}", not the {record["value"]:g} you typed. '
                'Type the amount again with browser_type and check the field shows it before trading.'
            )

    async def sequence_target(target: str):
        """A visible element for one sequence step: an owner-taught name, else an
        exact (then partial) visible label. None while it has not appeared yet."""
        try:
            remembered = await recall_target_name(target)
        except LookupError:
            remembered = None  # Taught but hidden right now; keep waiting.
        if remembered:
            return await browser.element(remembered['ref'])
        await browser.snapshot(max_chars=0, max_elements=400)
        needle = re.sub(r'\s+', ' ', target).strip().casefold()
        seen = [e for e in browser._refs.values() if e.get('inView', True)]
        for match in ([e for e in seen if (e.get('name') or '').casefold() == needle],
                      [e for e in seen if needle and needle in (e.get('name') or '').casefold()]):
            if match:
                return await browser.element(match[0]['ref'])
        return None

    @tool()
    async def browser_click_sequence(targets: list[str], within_seconds: float = 7.0, amount: float | str | None = None) -> dict:
        """Click several buttons in quick succession, for controls that only appear
        briefly after another click (e.g. ["BUY", "Double Up"]: Double Up shows for
        about 7 seconds after BUY). Each target is an owner-taught name or a visible
        label; each later step waits up to within_seconds for its button to appear
        and clicks it at once. Approval, if needed, is asked once up front.
        amount=12 first puts 12 in the page's amount box and confirms the box shows it."""
        ensure_control()
        steps = [t.strip() for t in targets if t and t.strip()]
        await apply_amount(amount, (await browser.page()).url, steps[0] if steps else '')
        if steps:
            await confirm_amount((await browser.page()).url, steps[0])
            await stake_limit(steps[0])
        if not 2 <= len(steps) <= 5:
            raise ValueError('Give two to five targets, in click order.')
        wait = min(max(within_seconds, 0.5), 15.0)
        url = (await browser.page()).url
        listed = ' then '.join(f'"{t}"' for t in steps)
        for step in steps:
            if MONEY.search(step):
                raise money_refusal(step)
        if any(RISKY.search(t) for t in steps) and not auto_approved(url):
            await ask(f"Click {listed} on {url}")

        async def work():
            clicked = []
            for index, target in enumerate(steps):
                limit = 5.0 if index == 0 else wait
                deadline = time.monotonic() + limit
                while True:
                    ensure_control()
                    try:
                        found = await sequence_target(target)
                    except LookupError:
                        found = None
                    if found:
                        info, locator = found
                        try:
                            await locator.click(timeout=2000)
                            clicked.append(f"[{info['ref']}] {info['name'] or target}")
                            break
                        except Exception:
                            pass  # Moved or covered mid-click; look again.
                    if time.monotonic() > deadline:
                        done = f" after clicking {', '.join(clicked)}" if clicked else ''
                        raise LookupError(f'"{target}" did not appear within {limit:g}s{done}. Check the page before retrying; earlier clicks in this sequence did happen.')
                    await asyncio.sleep(0.15)
            return {'clicked': ' then '.join(clicked)}

        result = await act(work, action={'kind': 'click_sequence', 'target': {'labels': steps, 'within_seconds': wait}})
        await journal_trade(steps[0])
        if any(re.search(r'double', step, re.I) for step in steps[1:]):
            await journal_trade(steps[0])  # Double Up opens a second trade the same way.
        return result

    @tool()
    async def browser_chart_read(candle: str = '15s', count: int = 12) -> dict:
        """Read the current asset's chart from the live price feed, by code: the last
        candles (G up / R down), RSI(14), MACD(12,26,9), EMA slope, and your own record
        of wins in setups like this one. Use this before each trade instead of a
        screenshot; candle is the candle size, e.g. "5s", "15s", "30s", "1m"."""
        period = min(max(expiry_seconds(candle), 1), 3600)
        page = await browser.page()
        await watch_feed(page)
        watching['period'] = period
        if not feed.ticks:
            await asyncio.sleep(2)  # The feed sends a price about twice a second.
        journal.settle(feed)
        key = await current_asset(page)
        chart = read_chart(feed, key, period, min(max(count, 3), 40))
        chart['your_record'] = journal.record_for(None, chart.get('setup'))
        return chart

    @tool()
    async def browser_trade_journal(limit: int = 20) -> dict:
        """Your recent trades with their setup at entry and result (settled from the
        price feed when each expiry passed), and win counts. Use it to learn which
        setups, directions and expiry times have been working."""
        journal.settle(feed)
        return {'record': journal.record_for(None, None), 'trades': journal.recent(min(max(limit, 1), 100))}

    @tool()
    async def browser_type(ref: int, text: str, submit: bool = False, expected_text: str = '') -> dict:
        """Type text into field [ref] (replacing its content); submit=true presses Enter after.
        During procedure recording expected_text checks a newly visible exact status label,
        not the typed input. Input values are not recorded. Existing confirmations apply."""
        ensure_control()
        info, locator = await browser.element(ref)
        is_search = info["type"] == "search" or info["role"] in ("searchbox", "combobox") or re.search(
            r"search|query|find", info["name"] or "", re.I
        )
        url = (await browser.page()).url
        await money_guard(info["name"] or "", locator)
        if info["type"] == "password":
            await ask(f"Type into \"{info['name']}\" on {url}")
        elif auto_approved(url):
            pass  # owner allowed this site to be operated freely
        elif not is_search or submit and RISKY.search(info["name"] or ""):
            shown = text if len(text) <= 120 else text[:120] + "..."
            await ask(f"Type into \"{info['name'] or 'field'}\"{' and press Enter' if submit else ''}:\n\"{shown}\"")

        async def work():
            await browser.highlight(locator)
            try:
                await locator.fill(text, timeout=10_000)
            except Exception as error:
                if 'not an <input>' not in str(error):
                    raise
                boxes = await amount_fields(await browser.page())
                listed = ', '.join(f"[{b['ref']}] showing {b['value']}" if b['ref'] else f"a box showing {b['value']}" for b in boxes)
                raise ValueError(f"[{ref}] {info['name'] or info['tag']} is not a box you can type in; nothing was typed."
                                 + (f" Number boxes on this page: {listed}." if listed else '')) from None
            if submit:
                await locator.press("Enter")
            shows = None
            if number(text) is not None:
                shows = await read_back((await browser.page()).url, await locator.element_handle(), text)
            return {"typed_into": f"[{ref}] {info['name']}", **({"field_shows": shows} if shows is not None else {})}

        return await act(work, action={'kind': 'type', 'target': {'label': await locator.get_attribute('aria-label') or await locator.get_attribute('placeholder') or info['tag'], 'input': '<runtime value, not stored>', 'submit': submit}}, expected_text=expected_text)

    @tool()
    async def browser_select(ref: int, option: str, expected_text: str = '') -> dict:
        """Choose an option (by visible label) in dropdown [ref]."""
        info, locator = await browser.element(ref)

        async def work():
            await locator.select_option(label=option, timeout=10_000)
            return {"selected": option}

        return await act(work, action={'kind': 'select', 'target': {'label': await locator.get_attribute('aria-label') or info['tag'], 'option': '<runtime value, not stored>'}}, expected_text=expected_text)

    @tool()
    async def browser_press(key: str) -> dict:
        """Press a key in the page, e.g. 'Enter', 'Escape', 'PageDown', 'Control+F'."""

        async def work():
            await (await browser.page()).keyboard.press(key)
            return {"pressed": key}

        return await act(work)

    @tool()
    async def browser_set_expiry(duration: str) -> dict:
        """Set the trade expiry time (how long the next trade runs), e.g. "5s", "15s",
        "30s", "1m", "2 min", "5m" or "00:01:30". Uses the site's preset when one matches,
        otherwise types hours/minutes/seconds, then confirms the Time box shows it.
        Choose the time from the chart: short times for quick moves, longer for trends."""
        seconds = expiry_seconds(duration)
        if not 3 <= seconds <= 4 * 3600:
            raise ValueError('Use an expiry from 3 seconds to 4 hours, e.g. "5s", "30s", "2m".')
        wanted = f'{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}'
        preset = {3: 'S3', 15: 'S15', 30: 'S30', 60: 'M1', 180: 'M3', 300: 'M5', 1800: 'M30', 3600: 'H1', 14400: 'H4'}.get(seconds)

        async def work():
            page = await browser.page()
            shown = page.locator('.block--expiration-inputs .value__val').first
            if not await shown.count():
                raise LookupError('No trade expiry ("Time") box was found on this page.')
            before = (await shown.inner_text()).strip()
            if before == wanted:
                return {'expiry': wanted, 'changed': False}
            panel = page.locator('.expiration-inputs-list-modal').first
            if not (await panel.count() and await panel.is_visible()):
                await page.locator('.block--expiration-inputs .control__value').first.click(timeout=3000)
                await panel.wait_for(state='visible', timeout=3000)
            if preset:
                await panel.locator('.dops__timeframes-item', has_text=re.compile(f'^{preset}$')).first.click(timeout=3000)
            else:
                boxes = panel.locator('input')
                if await boxes.count() != 3:
                    raise LookupError('The expiry panel did not show hours, minutes and seconds boxes. Nothing was changed.')
                for index, value in enumerate((seconds // 3600, seconds % 3600 // 60, seconds % 60)):
                    box = boxes.nth(index)
                    await box.click(timeout=3000)
                    await page.keyboard.press('Control+A')
                    await page.keyboard.type(f'{value:02d}', delay=20)
                    await box.dispatch_event('change')
            await asyncio.sleep(0.3)
            if await panel.is_visible():
                # Close the panel the way the owner does: click the Time box again.
                await page.locator('.block--expiration-inputs .control__value').first.click(timeout=3000)
            for _ in range(10):
                now = (await shown.inner_text()).strip()
                if now == wanted:
                    return {'expiry': wanted, 'was': before, 'changed': True}
                await asyncio.sleep(0.2)
            raise LookupError(f'The Time box shows {now}, not {wanted}. Check it before trading; the site may not allow that time.')

        return await act(work, action={'kind': 'set_expiry', 'target': {'label': wanted}})

    @tool()
    async def browser_choose_asset(name: str) -> dict:
        """Switch the traded asset / ticker / currency pair, e.g. "GBP/JPY OTC": opens the
        asset list from the current pair's button, scrolls the list window until the pair
        shows, clicks it and confirms the page now shows it. Use this instead of
        clicking or typing into the pair selector yourself."""
        wanted = ' '.join((name or '').split())
        if not wanted or len(wanted) > 60:
            raise ValueError('Give the asset name as shown in the list, e.g. "EUR/USD OTC".')

        async def mark(mode: str):
            return await (await browser.page()).evaluate(ASSET_JS, {'mode': mode, 'name': wanted})

        async def click_mark():
            await (await browser.page()).locator('[data-dots-asset="row"]').first.click(timeout=3000)

        async def work():
            page = await browser.page()
            before = (await mark('opener')) or ''
            if (await mark('tab'))['found']:
                await click_mark()  # A favourites tab showing it, no list needed.
            else:
                try:
                    taught = await recall_target_name('Asset selector')
                except LookupError:
                    taught = None
                if taught:
                    _, opener = await browser.element(taught['ref'])
                    await opener.click(timeout=3000)
                elif await mark('opener'):
                    await page.locator('[data-dots-asset="opener"]').first.click(timeout=3000)
                else:
                    raise LookupError('Could not find the current asset button to open the list. Teach it once as "Asset selector".')
                found, seen = False, []
                for _ in range(15):  # The list animates in.
                    await asyncio.sleep(0.2)
                    if (await mark('row'))['found']:
                        found = True
                        break
                if not found:
                    # Scroll the list window from the top until the asset shows.
                    for step in range(40):
                        result = await mark('scroll_top' if step == 0 else 'scroll')
                        seen += [s for s in result.get('seen', []) if s not in seen]
                        await asyncio.sleep(0.25)
                        if (await mark('row'))['found']:
                            found = True
                            break
                        if result.get('end'):
                            break
                if not found:
                    await page.keyboard.press('Escape')
                    shown = f" Assets in the list: {', '.join(seen[:60])}." if seen else ' No scrollable asset list was found after opening it.'
                    raise LookupError(f'"{wanted}" was not found in the asset list.{shown} Use a name exactly as listed.')
                await click_mark()
            for _ in range(20):
                await asyncio.sleep(0.2)
                now = await mark('opener')
                if now and await page.evaluate(ASSET_JS, {'mode': 'same', 'name': wanted, 'other': now}):
                    return {'switched_to': now, 'was': before, 'confirmed': True}
            raise LookupError(f'Clicked "{wanted}" but the page still shows "{await mark("opener") or before}" as the asset. Check the page before trading.')

        return await act(work, action={'kind': 'choose_asset', 'target': {'label': wanted}})

    @tool()
    async def browser_scroll(direction: str = "down", pages: int = 1) -> dict:
        """Scroll the page 'down' or 'up' by a number of screens."""

        async def work():
            page = await browser.page()
            amount = (pages if pages > 0 else 1) * (-1 if direction.lower() == "up" else 1)
            await page.evaluate("(n) => window.scrollBy(0, n * window.innerHeight * 0.9)", amount)
            return {"scrolled": direction}

        return await act(work)

    @tool()
    async def browser_back() -> dict:
        """Go back to the previous page."""

        async def work():
            await (await browser.page()).go_back(timeout=20_000)

        return await act(work)

    @tool()
    async def browser_tabs() -> dict:
        """List open browser tabs."""
        async with browser.lock:
            page = await browser.page()
            return {
                "tabs": [
                    {"index": i, "title": await p.title(), "url": p.url, "active": p == page}
                    for i, p in enumerate(browser._context.pages)
                ]
            }

    @tool()
    async def browser_switch_tab(index: int) -> dict:
        """Switch to the browser tab with this index (see browser_tabs)."""

        async def work():
            pages = browser._context.pages
            if not 0 <= index < len(pages):
                raise IndexError(f"No tab {index}; there are {len(pages)} tabs.")
            browser._page = pages[index]
            await browser._page.bring_to_front()

        return await act(work)

    @tool()
    async def browser_screenshot(full_page: bool = False) -> dict:
        """Save a screenshot of the current page (pass its path to describe_image to look at it)."""
        from PIL import Image
        import io

        async with browser.lock:
            page = await browser.page()
            data = await page.screenshot(full_page=full_page)
            image = Image.open(io.BytesIO(data))
            viewport = await page.evaluate("() => ({width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio})")
            return {
                "path": save_image(image, "browser"), "url": page.url,
                "image": {"width": image.width, "height": image.height},
                "viewport": viewport, "full_page": full_page,
                "coordinate_note": "Element bounds use viewport CSS pixels. Screenshot pixels may differ due to device scale. Full-page image positions also require scroll-offset conversion; use browser_click with a current element ref when possible.",
            }

    @tool()
    async def browser_close() -> dict:
        """Close the Dots' browser window (the profile and logins are kept)."""
        async with browser.lock:
            # Attached over CDP, close() only disconnects; ask Chrome to exit.
            if browser._browser is not None:
                try:
                    session = await browser._browser.new_browser_cdp_session()
                    await session.send("Browser.close")
                except Exception:
                    pass
            browser._reset()
            return {"closed": True}
