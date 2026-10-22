# Teach browser targets

## JEV-assisted button mapping

Ask a Dot: **“Use JEV to propose mappings for Open menu, Search, and Settings.
Let me review them before saving.”** `browser_map_propose` accepts 1–8 names.
Each visible proposal is highlighted in the browser. Choose **Confirm proposal**,
**Reject proposal**, or **Choose different button** and mark the correct control.
Correction clicks are intercepted; mapping never activates the controls.
After reviewing every item, tell the Dot to save. `browser_map_finish` validates
the confirmed elements and saves the batch together. Rejected items are not saved.
Existing unique taught names are updated; ambiguous names stop the save.

This uses the configured local JEV server. Proposals are model assessments, not
verified mappings until you confirm them. Busy pages use label-matched candidates
or an explicitly supplied set of up to seven current references. Missing or
uncertain matches need manual correction; the tool does not silently pick one.
Only visible DOM controls are proposed. Open hidden menus separately and use the
scroll-container or capture-region teaching below for menus and charts.

## Manual teaching

In a Dot with browser tools, ask: **“Teach the Open menu button.”**
The Dot calls `browser_teach_start` and the browser shows a teaching banner.
Click the desired control once, then tell the Dot **“I marked it.”** The teaching
click is intercepted instead of activating the control. Escape cancels before
marking; an unanswered teaching request expires after two minutes.
After marking, inspect the captured element label in the browser and click
**Confirm taught target**, or **Cancel taught target** if it is wrong. No target
is saved until you confirm and the Dot successfully calls `browser_teach_finish`.
Page navigation cancels the unsaved teaching state.

Only one unfinished teaching session is allowed on the page. Starting another
target is rejected until the current target is saved or explicitly cancelled.
`browser_teach_status` reports waiting, marked, confirmed-but-unsaved, saved, or
cancelled/expired. Use `browser_teach_cancel` only when the owner wants to discard
the current selection. Unique saved names are accepted by target lookup as well
as saved IDs. Chat completion receipts report actual teaching tool results;
assistant prose alone does not establish a save. Never click a target for teaching
unless the teaching overlay is visible.

For a scrollable menu, open it yourself first and ask **“Teach this scrollable
menu.”** DOTS uses `kind=scroll_container`; click any row inside the scrolling
region. It records the nearest scrollable ancestor, not the whole browser page.

If clicking does not identify the menu, ask **“Let me draw around this scrollable
menu.”** The Dot calls `browser_teach_start` with `kind=scroll_container` and
`selection=area`. Drag tightly around the open menu, then confirm its captured
label. The rectangle must identify one scroll container; ambiguous selections
remain unsaved. Custom containers using `overflow: hidden` and a unique scrollable
child inside a clicked wrapper are also recognized. Canvas and iframe contents
are not mapped as DOM menus by this picker.

For visual focus, ask **“Let me draw a capture area named RSI panel.”** The Dot
uses `kind=region`. Drag a rectangle within the browser page, click **Confirm
taught target**, then tell the Dot to finish saving. `browser_region_capture`
returns a fresh cropped screenshot of that named rectangle. Its name, bounds and
reference image persist alongside the other targets. This covers browser page
content, not other desktop windows or browser chrome.

Capture regions are observation areas, not clickable targets. Reload, navigation,
viewport resizing or outer-page scrolling invalidates reuse until you teach the
area again. Within a valid region, content can still change: inspect the fresh
image before interpreting it. This feature does not automatically OCR a menu,
identify a chart signal, or scroll image-only menus. The saved image is a reference,
not evidence of the current screen.

Targets persist in `data/browser-targets.sqlite`, scoped to site origin and path.
Query strings and credentials are excluded from page identity. Stored data includes
the owner's name, DOM identity, initial bounds, expected outcome label, and a
cropped reference image in `localtools/output`. Labels and images may contain
private page content; teach only the intended controls. No input values are
explicitly extracted. The reference image is for review; image-template matching
is not implemented.

`browser_targets` lists saved targets. `browser_target_find` resolves a unique,
visible, uncovered element to a fresh ref using its current DOM identity, without
taking a screenshot. A moved element is found at its new position. Changed labels,
missing or duplicate identities require inspection or re-teaching. Coordinates
never authorize a click. Use ordinary `browser_click` with the returned ref;
existing permissions, confirmations and procedure recording still apply.

Saved names also work directly in `browser_find`, `browser_jev_find`, and visual
click/type requests. For example, `sell_button` and `sell button` match the same
saved alias. These tools resolve its current DOM identity first. JEV receives that
current candidate and its actual label for assessment; saved reference images are
not used to train JEV. Visual actions can reuse the resolved element without a new
grounding screenshot. Missing or ambiguous mappings stop instead of falling back
to a guess. Use `browser_targets` to discover the exact names; arbitrary paraphrases
do not match automatically. Capture regions remain observation-only.

`browser_menu_map(target_id, max_pages=10, capture_images=false)` scans only the
taught container with overlapping scroll increments, deduplicates observed labels,
and restores its starting scroll position. Enable cropped images for visual review
when DOM text is insufficient. At most 20 viewports are scanned. Maps report
`reached_bottom`; this does not prove that every lazily loaded item was discovered.
Image-only/canvas menus need visual review; the tool does not OCR or stitch images.

`browser_menu_find(target_id, label)` searches by exact label using current visible
rows, including menus that recycle DOM nodes. It leaves the match in view and
returns a fresh ref without clicking. Missing or ambiguous matches stop. Duplicate
labels may require a more specific target or manual review. Owner browser takeover
stops automated scrolling; hand control back before mapping.

`browser_target_forget` deletes a target when requested. Reference PNGs remain in
the output folder. Teaching marks a control; it does not verify an action or
automatically resume blocked workflows. A scheduled workflow needing teaching
reports that owner input is needed rather than polling indefinitely.
