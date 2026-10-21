"""Set up an options order on Robinhood up to the owner's button.

The Dot opens the chain, picks the expiry, adds each leg, presses Continue, fills
the contracts, limit price and time in force, then outlines Review order and
rests the mouse on it. Review order and everything after it are the owner's:
order_guard refuses those clicks on robinhood.com.

Page facts (mapped 2026-10-21; Site Maps/Robinhood/Robinhood.md):
- robinhood.com/options/chains/SYMBOL opens the chain; leaving it clears the ticket.
- Expiry: [data-testid=SelectExpirationDateDropdown], options [role=option][data-testid=YYYY-MM-DD].
- Side and type: buttons in [data-testid=OptionChainSideControl] (Buy/Sell) and
  [data-testid=OptionChainOptionTypeControl] (Call/Put).
- Strikes: [data-testid="ChainTableRow-776.00"] [data-testid=OptionChainSelectRowButton].
  Rows are virtualized (only ~6 exist at a time), so the chain is wheel-scrolled
  until the row exists.
- After Continue: #OptionOrderForm-Quantity-FormField, #OptionOrderForm-LimitPrice-FormField
  (its placeholder is the mid), a "Good for Day" / "Good till Canceled" picker,
  and "Estimated credit" / "Estimated debit".
"""
import asyncio
import re

import order_guard

CHAIN = 'https://robinhood.com/options/chains/{}'

ROW = r"""(strike) => {
  const head = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'Strike price');
  const top = head ? head.getBoundingClientRect().bottom + 10 : 300;
  const rows = [...document.querySelectorAll('[data-testid^="ChainTableRow-"]')];
  const strikes = rows.map(e => parseFloat(e.getAttribute('data-testid').slice(14)));
  if (!rows.length) return {rows: 0};
  const box = rows[0].parentElement.getBoundingClientRect();
  const at = {x: box.x + box.width / 2, y: Math.min(Math.max(top + 100, box.y + 50), innerHeight - 100)};
  const row = document.querySelector(`[data-testid="ChainTableRow-${strike}"]`);
  if (!row) return {rows: rows.length, found: false, high: Math.max(...strikes), low: Math.min(...strikes), at};
  const r = row.getBoundingClientRect();
  return {rows: rows.length, found: true, y: r.y, visible: r.top >= top && r.bottom <= innerHeight - 10, top, at};
}"""

PANEL = r"""() => {
  const panel = [...document.querySelectorAll('button')].find(b => /^(Continue|Review order)$/.test(b.innerText.trim()));
  let box = panel;
  for (let i = 0; box && i < 8 && !/Spread|Call|Put|Contracts/.test(box.innerText.split('\n')[0] + box.innerText.slice(0, 300)); i++) box = box.parentElement;
  return box ? box.innerText : '';
}"""


def check_legs(legs: list) -> list:
    out = []
    for leg in legs or []:
        action, kind = str(leg.get('action', '')).lower(), str(leg.get('type', '')).lower()
        if action not in ('buy', 'sell') or kind not in ('call', 'put'):
            raise ValueError('Each leg needs action buy/sell and type call/put, e.g. {"action": "sell", "type": "put", "strike": 776}.')
        out.append({'action': action, 'type': kind, 'strike': float(leg['strike'])})
    if not 1 <= len(out) <= 4:
        raise ValueError('Give 1 to 4 legs.')
    return out


async def pick(page, control: str, text: str):
    button = page.locator(f'[data-testid={control}] button', has_text=re.compile(f'^{text}$', re.I)).first
    await button.click(timeout=5000)
    await asyncio.sleep(0.6)


async def add_row(page, strike: float):
    key = f'{strike:.2f}'
    for _ in range(60):
        s = await page.evaluate(ROW, key)
        if not s['rows']:
            raise LookupError('The chain shows no strikes.')
        if s['found'] and s['visible']:
            button = page.locator(f'[data-testid="ChainTableRow-{key}"] [data-testid=OptionChainSelectRowButton]').first
            await button.click(timeout=5000)
            await asyncio.sleep(0.8)
            return
        up = (s['found'] and s['y'] < s['top']) or (not s['found'] and strike > s['high'])
        if not s['found'] and s['low'] <= strike <= s['high']:
            raise LookupError(f'There is no ${strike:g} strike on this expiry.')
        await page.mouse.move(s['at']['x'], s['at']['y'])
        await page.mouse.wheel(0, -250 if up else 250)
        await asyncio.sleep(0.35)
    raise LookupError(f'Could not scroll the chain to the ${strike:g} strike.')


async def set_up(page, ticker: str, expiry: str, legs: list, qty: int = 1, limit: float | None = None,
                 good_till: str = 'day', ensure=lambda: None) -> dict:
    """Set up the order on this Robinhood page and stop at Review order (see the
    robinhood_options_set_up tool). ensure() is called between steps: it raises
    when the owner has taken control."""
    ensure()
    ticker = re.sub(r'[^A-Z.]', '', ticker.upper())[:6]
    if not ticker or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', expiry):
        raise ValueError('Give a ticker like "SPY" and an expiry like "2026-10-23".')
    legs = check_legs(legs)
    qty = int(qty)
    if not 1 <= qty <= 100:
        raise ValueError('qty must be 1 to 100 contracts.')
    good_till = 'Good till Canceled' if str(good_till).lower() in ('gtc', 'good till canceled') else 'Good for Day'
    await page.goto(CHAIN.format(ticker), wait_until='domcontentloaded', timeout=30000)
    await page.get_by_text('Strike price').first.wait_for(timeout=20000)
    await asyncio.sleep(1)
    await page.locator('[data-testid=SelectExpirationDateDropdown]').click(timeout=5000)
    await asyncio.sleep(0.6)
    option = page.locator(f'[role=option][data-testid="{expiry}"]')
    if not await option.count():
        offered = await page.evaluate("() => [...document.querySelectorAll('[role=option][data-testid]')].map(e => e.getAttribute('data-testid'))")
        await page.keyboard.press('Escape')
        raise LookupError(f'{ticker} has no {expiry} expiry. Offered: {", ".join(offered[:12])}')
    await option.click(timeout=5000)
    await asyncio.sleep(1.2)
    for leg in legs:
        ensure()
        await pick(page, 'OptionChainOptionTypeControl', leg['type'])
        await pick(page, 'OptionChainSideControl', leg['action'])
        await add_row(page, leg['strike'])
    ticket = await page.evaluate(PANEL)
    missing = [f'${leg["strike"]:g}' for leg in legs if f'${leg["strike"]:g}' not in ticket]
    if missing:
        raise RuntimeError(f'The ticket is missing {", ".join(missing)}. Ticket reads: {ticket[:400]}')
    cont = page.get_by_role('button', name='Continue')
    if not await cont.count():
        raise RuntimeError(f'No Continue button: Robinhood says: {ticket[:400]}')
    order_guard.check_click(page.url, 'Continue')
    await cont.first.click(timeout=5000)
    box = page.locator('#OptionOrderForm-Quantity-FormField')
    await box.wait_for(timeout=10000)
    await box.fill(str(qty))
    price = page.locator('#OptionOrderForm-LimitPrice-FormField')
    mid = (await price.get_attribute('placeholder') or '').lstrip('$')
    await price.fill(f'{limit:.2f}' if limit is not None else mid)
    await asyncio.sleep(0.5)
    shown = page.locator('button', has_text=re.compile(r'^Good (for Day|till Canceled)')).first
    if (await shown.inner_text()).strip() != good_till:
        await shown.click(timeout=5000)
        await page.get_by_role('option', name=re.compile(f'^{good_till}')).first.click(timeout=5000)
    await asyncio.sleep(0.8)
    form = await page.evaluate(PANEL)
    buttons = await page.evaluate(order_guard.SHOW_ORDER_BUTTONS, order_guard.ORDER.pattern)
    if buttons:  # Rest the mouse on Review order: a hover, never a click.
        await page.mouse.move(buttons[0]['x'], buttons[0]['y'], steps=12)
    estimate = re.search(r'Estimated (credit|debit)\s*\$?([\d,.]+)', form)
    quote = re.search(r'Bid \$([\d.]+)\D+Ask \$([\d.]+)', form)
    warning = None
    if quote and limit is not None and not float(quote[1]) <= limit <= float(quote[2]):
        warning = (f'The limit ${limit:.2f} is outside the live bid ${quote[1]} / ask ${quote[2]} (mid ${mid}): '
                   'the suggestion is stale or the market moved. Re-check before the owner reviews it.')
    return {
        'warning': warning, 'bid_ask': [float(quote[1]), float(quote[2])] if quote else None,
        'result': 'ready_for_owner', 'ticker': ticker, 'expiry': expiry, 'legs': legs, 'qty': qty,
        'limit': limit if limit is not None else float(mid or 0), 'mid_shown': mid, 'good_till': good_till,
        'estimate': f'{estimate[1]} ${estimate[2]}' if estimate else None,
        'mouse_on': buttons[0]['label'] if buttons else None, 'form': form[:600],
        'tell_the_owner': ('The order is set up on Robinhood with the mouse on Review order. Check the legs, '
                           'contracts and limit price, then press Review order and submit it yourself.')}


def register_robinhood_tools(tool, browser, ensure_control):
    @tool()
    async def robinhood_options_set_up(ticker: str, expiry: str, legs: list, qty: int = 1,
                                       limit: float | None = None, good_till: str = 'day') -> dict:
        """Set up an options order on Robinhood and stop at Review order for the owner.
        ticker e.g. "SPY"; expiry "YYYY-MM-DD"; legs as in an options_suggest
        suggestion, e.g. [{"action": "sell", "type": "put", "strike": 776},
        {"action": "buy", "type": "put", "strike": 775}]; qty = contracts;
        limit = the price per contract (the suggestion's 'limit', a positive
        credit or debit; omit to keep Robinhood's mid); good_till "day" or "gtc".
        Opens the chain fresh (any earlier ticket is cleared), adds the legs,
        presses Continue, fills the form, outlines Review order and rests the
        mouse on it. The owner checks it and presses Review order themselves;
        the Dots never press it."""
        async with browser.lock:
            return await set_up(await browser.page(), ticker, expiry, legs, qty, limit, good_till, ensure_control)
