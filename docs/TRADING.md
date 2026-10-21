# Trading and options: where everything lives

A map of the trading code for the Developer Dot and anyone changing it. Last updated
2026-10-21. The decisions behind it (rules, sizing, results) are in the owner's Obsidian vault:
`C:\Users\inter\Desktop\MainAINotes\Site Maps\Robinhood\` (Credit Spread Rules, Edge List,
Edge Lab, Options Order Setup).

## The lines that never move

- **The Dots never press an order button on Robinhood** (Review order, Submit, Place, Confirm,
  Swipe up). They do everything up to it, then outline it (blinking) and rest the mouse on it.
  This is enforced in `localtools/order_guard.py` with the site list in
  `localtools/browser-policy.json` (`ownerPressesOrders`). Both are protected: the Developer
  cannot edit them, and no change may work around them (for example by clicking with raw mouse
  events, pressing Enter on an order form, or calling a broker API).
- **Only the owner turns on the autopilot**, with their PIN, from the app's Autopilot button.
  When it is on, the autopilot process (not a Dot) presses order buttons after its own checks.
  `localtools/autopilot.py` holds the PIN check, the signed on/off state, the minimum record
  and every order check, and is protected. Its state lives in `C:\ProgramData\OpenDots\autopilot`,
  outside the Dots' file tools. No change may let a Dot, the Developer or a tool turn it on,
  skip a check, or press an order button another way.
- **Pocket Option runs on the demo account.** New sites start on demo or paper (see
  `docs/SITE-MAPPING.md`).
- **The owner's options rules:**
  - SPY, QQQ and TSLA only, expiring within 14 days.
  - $100 max loss a trade, $40 for debit spreads and lottos.
  - One trade at a time, $60 daily loss limit.
  - Always a limit order near the mid.
  - The goal is a small profit on nearly every trade, not the biggest profit.
  - Change these only when the owner asks.

## Files

### Options guide (Robinhood, the owner's own account)

| File | What it does | Change it to... |
|---|---|---|
| `localtools/options_guide.py` | Market data (Cboe delayed chains, Yahoo near-real-time minutes), the trade finders (credit and debit spreads, lottos, edge-lab signals), the journal (`data/options-guide.sqlite`), the replay model `track()`, and the `options_*` tools. | Adjust the rules (constants at the top: `TICKERS`, `MAX_DAYS`, `MAX_LOSS`, `MAX_DEBIT`, `DAILY_LOSS_LIMIT`, `SHORT_DELTA`, `MIN_POP`, `EDGE_SIGNALS`), profit target and stop (`track()`), add a trade type (a finder plus `FINDERS`). |
| `localtools/options_watch.py` | The exit listener, a separate process. It reprices each taken trade every 30s and fires the profit target, stop, trailing stop and 3:45pm exit. It then sets up the closing order in its own tab and notifies the owner (Windows toast and `data/options-alerts.jsonl`). | Adjust the trailing stop (`LOCK_MIN`, `LOCK_SHARE`, `FLOOR_KEEP`, `FLOOR_MIN`), the poll rate (`EVERY_S`), or how the owner is told (`notify`). |
| `localtools/robinhood_ticket.py` | `set_up()` and the `robinhood_options_set_up` tool. Opens the chain, picks the expiry, adds the legs (scrolling the virtualized rows), presses Continue, and fills contracts, limit and time in force. The page facts (selectors) are in its docstring. | Fix it when Robinhood changes its page: update the `data-testid`s and ids there. |
| `localtools/options_eod.py` | End of day: saves the day's prices and scores suggestions. | |
| `localtools/edge_lab.py` | Backtests signals on 60 days of 5-minute bars and writes `Edge Lab.md` to the vault. Re-run it weekly. | Add or tune a signal (`signals()`). A signal goes live only after it passes on unseen days, after costs. |
| `src/client/OptionsAlerts.tsx`, route `GET /api/options/alerts` in `src/server/app.ts` | The alert banner, chime and phone notification. | |
| `localtools/autopilot.py` (protected) | The autopilot. **Turning it on:** the owner's PIN, set once with `python localtools/autopilot.py set-pin`, with a lock after 5 wrong tries. **Modes:** dry_run (stops at the review screen) and live (submits; only for trade kinds with 20+ scored results, 80% wins and a positive profit per trade). **Checks before any press:** the rules, the order form read back (contracts, limit, strategy name, money at risk), the review screen (opening vs closing). It turns itself off at 4pm. | Ask the owner: this file is theirs. |
| `src/client/AutopilotButton.tsx`, routes `GET/POST /api/autopilot` in `src/server/app.ts` | The Autopilot button: status, the minimum record, recent orders, on with the PIN, off without one. | |

### Browser, site maps and routines (all sites)

| File | What it does |
|---|---|
| `localtools/browser.py` | The shared Chrome (CDP port 9333), the `browser_*` tools, and the Pocket Option trading tools (`may_add` blocks stacking trades on the same pair; `REAL_MAX_EXPIRY`). It also holds the money guard, so review changes carefully. |
| `localtools/site_maps.py` | Per-site maps in the vault (`Site Maps/<Site>/`): taught targets, routines, keyboard shortcuts. |
| `localtools/site_routines.py` | Saved routines (`site_routine_*`), recording and shortcuts. A `handoff` step stops at the order button for the owner. |
| `localtools/browser_targets.py`, `browser_mapping.py` | Teaching and recalling named buttons and fields; registers the routine and Robinhood tools. |
| `localtools/trading_feed.py`, `shadow_report.py` | Pocket Option price ticks and the shadow replay of trade setups. |
| `src/server/browser-live.ts`, `browser-routes.ts`, `src/client/BrowserPanel.tsx`, `SiteMapPanel.tsx` | The live browser view in the app, phone gestures, and the site map panel. |

### Running pieces

- **Scheduled tasks (Windows):**
  - "OpenDots Options Exit Listener" runs weekdays at 9:25am (`options_watch.py`, stops at 4:05pm).
  - "OpenDots Options End of Day" runs weekdays at 4:15pm (`options_eod.py`).
  - Both run from the main checkout, so an applied change reaches them at their next start.
- **Tools reach the Dots after an OpenDots restart.** The tool groups are in
  `src/shared/capabilities.ts` (`options`, `browser`, `site_mapping`). That file is protected,
  so ask the owner to add a new tool to a group.

## Tests

From `localtools` with `.venv\Scripts\python.exe -m unittest discover -p "test_*.py"` (`dev_checks`
runs them):

| Test | Covers |
|---|---|
| `test_options_guide.py` | Rules gate, finders, journal, replay, signals. |
| `test_options_watch.py` | Trailing stop, alerts sent once, failed set-up still notifies. |
| `test_robinhood_ticket.py` | Leg checks. |
| `test_*_live.py` | Need a real Chrome and `LOCALTOOLS_LIVE_TEST=1`. They use a test page, never a broker. |

A change to exits or rules needs a test that shows the new behavior on a made-up price path
(see `test_options_watch.py`).
