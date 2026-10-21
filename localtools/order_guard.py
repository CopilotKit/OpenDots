"""Owner-only order buttons: on these sites the Dots prepare a trade (ticker,
contracts, quantity) and the owner presses the button that places the order.

Listed in browser-policy.json as {"ownerPressesOrders": ["robinhood.com"]}. The
guard holds in every mode: unattended mode answers "allowed" to confirmations,
so asking first is not enough (2026-10-21). Choosing Buy or Sell, Call or Put,
an expiry or a strike stays allowed; that is the preparation.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

POLICY_FILE = Path(os.environ.get("LOCALTOOLS_BROWSER_POLICY", Path(__file__).parent / "browser-policy.json"))

# Controls that place, review or send an order.
ORDER = re.compile(
    r"\b(review|submit|place|confirm|send|preview)\b[^.\n]{0,20}\border\b"
    r"|\border\b[^.\n]{0,20}\b(review|submit|place|confirm|send)\b"
    r"|\bswipe up\b|^\s*submit\b|\bplace trade\b",
    re.I,
)

# The active element is a search box (Enter there searches, it orders nothing).
SEARCH_FOCUSED = r"""() => { const e = document.activeElement; if (!e || e === document.body) return false;
  const label = (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || '').toLowerCase();
  return e.type === 'search' || ['searchbox', 'combobox'].includes(e.getAttribute('role') || '') || /search|symbol|ticker/.test(label); }"""

# Outlines the order buttons for the owner at hand-off and returns where the
# first one is, so the mouse can rest on it (a hover, never a click).
SHOW_ORDER_BUTTONS = r"""(pattern) => { const re = new RegExp(pattern, 'i'); const found = [];
  if (!document.getElementById('dots-press-here')) {  // Blinks until the owner presses it.
    const s = document.createElement('style'); s.id = 'dots-press-here';
    s.textContent = '@keyframes dotsPressHere{0%,100%{outline-color:#f59e0b;box-shadow:0 0 0 0 #f59e0b99}50%{outline-color:transparent;box-shadow:0 0 18px 6px #f59e0b99}}'
      + '[data-dots-press-here]{outline:4px solid #f59e0b!important;outline-offset:2px;animation:dotsPressHere 1s ease-in-out infinite}';
    document.head.appendChild(s); }
  for (const e of document.querySelectorAll('button,a,[role=button],input[type=submit]')) {
    const t = (e.getAttribute('aria-label') || e.innerText || e.value || '').trim();
    const r = e.getBoundingClientRect();
    if (t && re.test(t) && r.width > 1 && r.height > 1) {
      e.setAttribute('data-dots-press-here', '');
      found.push({label: t.slice(0, 60), x: r.x + r.width / 2, y: r.y + r.height / 2});
    }
  } return found; }"""


def owner_presses_orders(url: str) -> bool:
    try:
        sites = json.loads(POLICY_FILE.read_text(encoding="utf-8")).get("ownerPressesOrders", [])
    except (OSError, ValueError):
        return False
    host = (urlparse(url).hostname or "").lower()
    return any(host == s.lower() or host.endswith("." + s.lower()) for s in sites)


def check_click(url: str, name: str) -> None:
    """Refuse a click on an order button on an owner-presses-orders site."""
    if owner_presses_orders(url) and ORDER.search(name or ""):
        host = urlparse(url).hostname
        raise PermissionError(
            f'No click was made: "{name}" places or reviews an order on {host}. On this site the owner '
            'presses order buttons themselves; the Dots only prepare the setup. Stop here and tell the owner '
            'the order is ready for their review.')


async def check_enter(page) -> None:
    """Refuse Enter outside a search box on an owner-presses-orders site: in an
    order form Enter can submit the order."""
    if owner_presses_orders(page.url) and not await page.evaluate(SEARCH_FOCUSED):
        raise PermissionError(
            f'No key was pressed: Enter outside a search box could submit an order on {urlparse(page.url).hostname}. '
            'The owner places orders on this site; stop and tell them the setup is ready.')
