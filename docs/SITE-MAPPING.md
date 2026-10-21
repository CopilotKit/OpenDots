# Mapping a website

How OpenDots learns a new site so the Dots can use it like an API, and the rules for doing it.
Set up 2026-10-19, after Pocket Option was mapped by hand.

## The rules

1. **Demo or paper first, always.** A site that handles money is mapped and run on a demo or
   paper account. Strategies are proven on recorded, real outcomes before anyone talks about live
   money. Every decision is logged with its reason and result, so people can learn from it.
2. **Map everything the page needs.** Reads (quotes, balances, history, search) and writes
   (submit, order, post buttons) are both mapped: a demo account uses the same buttons as a real
   one. Learn writes with `write=True` on `site_capture` / `site_add`; `call_operation` can run
   them (the api_anything server starts with `--allow-writes`). Keeping money sites on demo is
   the owner's rule, not a tool restriction.
3. **Verify against the page.** An operation counts only after its output matches what the page
   shows for the same input, and `site_verify` passes.
4. **Measure, then change.** One change at a time, judged on the results.

## Mapping a page for native-like use

The goal is that a Dot can use each page the way a person would: every button, field, scroll
box, menu and important area known by name, the common flows recorded, and the data available
as API calls. Do this page by page, with the owner watching the live browser panel.

1. **Open the page** (`browser_open`) on the demo/paper account and take a `browser_snapshot`.
2. **Buttons and fields, in batches.** `browser_map_propose` with up to 8 descriptive names
   ("Search box", "Buy button", "Next page"). The browser highlights each guess; the owner
   confirms, rejects or corrects it, then `browser_map_finish` saves the confirmed names. Repeat
   until every control the page needs is named. Anything the batch misses (a button that only
   appears after another click, an icon with no text) is taught one at a time with
   `browser_teach_start` (kind `button`): the owner clicks it once and confirms.
3. **Scroll boxes and menus.** `browser_teach_start` kind `scroll_container`: the owner drags
   around the list; then `browser_menu_map` collects its entries and `browser_menu_find` picks one
   by its label later.
4. **Areas** (a chart, a status panel): `browser_teach_start` kind `region`; the owner draws it;
   `browser_region_capture` gives a fresh image of it on demand.
5. **Flows.** For each task done on the page ("search and open the first result", "change the
   amount"), `browser_procedure_start`, do the steps with the named targets, giving each click the
   label that should appear afterwards (`expected_text`), then `browser_procedure_finish`. Next
   time `browser_procedure_recall` brings the checked steps back.
6. **Data.** For what the page shows (results, prices, balances), map it as an API operation with
   the tools below, so reading it no longer needs the page at all.
7. **Check it.** `browser_targets` lists what the page now knows; run each flow once more from a
   fresh load; `site_verify` the data operations.

Taught names follow the page across reloads and layout changes (they are found again by their
label and position, not by fixed coordinates). Re-teach a target if the site redesigns it.

## Site maps in Obsidian, and routines

Everything taught is kept as Obsidian notes (2026-10-20), one folder per site, in
`LOCALTOOLS_SITE_MAPS` (mcp.servers.json; the owner's vault `MainAINotes/Site Maps`):

- `<Site>/<Site>.md`: addresses, start page, and everything mapped, by page.
- `<Site>/Targets/<name>.md`: one taught button, menu or area, with its picture. A target keeps
  the page it was taught on (Pocket Option's demo and live pages stay separate); on another page
  of the same site it is used only if it is actually found there. Re-teaching a name keeps the
  old version under "Earlier versions", so a changed layout is re-mapped without losing the old.
- `<Site>/Routines/<name>.md`: a routine, its readable steps and fill-ins such as `{pair}`.

Each note's machine data is the JSON block under "## Data"; the rest is rebuilt on every save.
The old `data/browser-targets.sqlite` is copied in once at start and otherwise left alone.

**Routines** are tasks done once and replayed: record one from the live view (Site map →
name, fill-ins such as `pair=EURUSD`, Record; do the task; Finish), or a Dot saves one with
`site_routine_save` after doing the task. `site_routine_run` (or Run in the panel) replays it
with new fill-ins: each step finds its element again on the live page, is checked, and the run
stops at the first step that fails. Dots with the browser or site-mapping tools are told which
sites are mapped, with their targets and routines, at the start of every run.

## The data tools

| Step | Tool | What it does |
| --- | --- | --- |
| 1 | `site_capture` | Loads a page with an example input and ranks the requests the site's own frontend made, with a suggested recipe. |
| 2 | `site_inspect` | Shows one captured request and response, and tries a recipe (`extract`/`pick` for JSON, `html` for server-rendered lists). |
| 3 | `site_add` | Saves an operation from two different example inputs (the request that changes with them is learned); `write=True` for submit/order operations. |
| 4 | `site_verify` | Calls every saved operation with its examples and repairs ones that broke. |
| – | `site_list` | The mapped sites, or one site's operations. |
| use | `call_operation` (api_anything server) | Calls a saved operation and returns JSON. `list_sites`, `list_operations` and `login` too. |

These come from [API Anything](https://github.com/goodnight000/api-anything), built in
`C:\Users\inter\Desktop\AIVoice\api-anything` (Node 22.13+). OpenDots runs its MCP server from
`mcp.servers.json` (`api_anything`); the `site_*` tools are in `localtools/site_mapper.py`.
Learned sites are stored in `%USERPROFILE%\.api-anything\sites\<site>.json` (that folder is the
registry of mapped sites; logins are kept there as references, never in the specs).

## Worked example (Open Library search)

1. `site_capture("https://openlibrary.org/search?q=dune", {"q": "dune"})` found the search page
   carrying `q` and suggested a list recipe: items `li.searchResultItem`, title `a.results`.
2. `site_add("openlibrary", "search", "https://openlibrary.org/search?q={q}", {"q": "dune"},
   {"q": "foundation"}, html='{"items":"li.searchResultItem","fields":{"title":"a.results",
   "url":"a.results@href","author":"span.bookauthor a"}}')` saved it (20 results previewed).
3. `call_operation("openlibrary", "search", {"q": "neuromancer"})` returned titles, links and
   authors as JSON over plain HTTP, no browser.

## When it does not fit

- **Live streams.** Prices that arrive over a WebSocket (Pocket Option's feed) are not ordinary
  requests; they need a feed reader in code, as `trading_feed.py` does.
- **Bot challenges and CAPTCHAs** need the owner to clear them in a real browser.
- **Sign-in:** use `login` (it opens a browser window on Windows); never type passwords into tools.
- **Owner-taught buttons** (the browser panel's "Teach a button") still work for sites where
  clicking through the page is the only way.

## Checklist for a new site

- [ ] Demo/paper account open in OpenDots' browser; real account not signed in.
- [ ] List the reads needed (what data, which inputs).
- [ ] Capture, inspect, add each read; check one result against the page by eye.
- [ ] `site_verify` passes.
- [ ] Record what was mapped and any limits in this file or the site's description.
- [ ] Writes (submit, order etc.): capture and add with `write=True`, test once on the demo account.
