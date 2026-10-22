# Browser procedure memory

LocalTools now supports structured, versioned procedures in `data/browser-procedures.sqlite`.
This is separate from conversational memory and free-text learned skills.

1. On the starting page, call `browser_procedure_recall` to inspect prior versions for that exact origin and path. Query strings, credentials and fragments are excluded from the stored page context.
2. Call `browser_procedure_start` with a name and objective. Only one recording can be active in the shared browser. Finish it before another task starts recording.
3. Use ordinary browser actions. Click, visual-click, type, visual-type and select actions accept optional `expected_text`. This must be an exact UI label that is absent before the action and visible afterward. During recording, the wrapper records ordered actions, semantic targets, available geometry, viewport, page transitions, expected labels and verification results automatically.
4. Call `browser_procedure_finish`. A nonempty version is verified only if every recorded action passed its UI check. Missing checks, errors and incomplete memory writes result in `needs_review`.
5. Use `browser_procedure_forget` with the saved ID when the owner requests deletion.

Example: record “Open account menu”, locate the current “Account” button, click its ref with `expected_text: "Sign out"`, then finish. That verifies the appearance of the label, not authentication status or any larger business objective.

Recall never replays actions. Re-find targets on the current page; stored geometry is a hint, not a click command. A fresh recording creates another version rather than rewriting historical evidence. A server restart leaves an unfinished version as `recording`; it is not resumed or marked verified automatically.

Typed values and selected option values are not captured in action records; they remain runtime parameters. Do not put credentials, message bodies or private input values in objectives, labels or expected text. Procedure names, labels and evidence are local persisted data. The ordinary conversation/tool logs have their own retention behavior.

Current verification is a newly visible exact text label. It does not infer success from model narration or screenshots, prove application/backend persistence, or verify input values. Actions without this check (including navigation/scroll/key tools) remain unchecked. The feature has no autonomous replay, visual-only verification or dedicated procedure editor yet. Browser tool permissions and existing action confirmations still apply.
