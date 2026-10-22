# Team board

## Checkpoint continuation

Scheduled workflows use a compact board snapshot as each turn's model context;
full conversation history and original receipts remain archived. Completed steps
and the latest partial-work checkpoint are carried forward instead of replayed.

A specialist turn yields at 20 model/tool cycles (or its lower configured limit),
or when the estimated message context budget is reached after tool results. The
scheduler also handles an early final answer without a report. It requests one
reporting-only turn, with MCP, skill and client action tools disabled. The Dot may
submit `report_team_step`, or `checkpoint_team_step` when verified partial progress
and authorized remaining work exist. The checkpoint contains completed work,
remaining work, next action and a new receipt ID from the current step. It is
persisted before the next execution turn and does not consume an execution retry.

Repeated receipts/progress and more than three continuations per step are rejected.
Uncertain tool failures and disconnects remain for manager review; they are not
automatically retried. Context budgeting uses a character estimate, not an exact
provider tokenizer. Owner stop/pause, permission checks and the overall scheduler
ceiling still apply. A restart preserves checkpoints but does not replay or resume
interrupted actions. Ordinary chat is not an automatically recurring workflow;
this continuation mechanism runs only in scheduled Team workflows.

## Delegate to the Project Manager

Give the Project Manager the complete request in chat. With delegation enabled, it can use `list_specialists` and `start_team_workflow` to create one shared board, choose only the needed teammates, and remain the manager. You can also start **Manager-led execution** directly from Team.

Workflow tools accept exact specialist names or IDs; ambiguous names are rejected. Boards created from chat keep their originating conversation ID. `read_team_board` may omit `id` to read that conversation's latest board or a participant's assigned board; it never falls back to an unrelated board. Status results explicitly state whether execution is running. A failed start or unresolved progress lookup ends the current reply with a server error instead of letting the model continue to announce success.

The manager assigns ordered steps with an assignee and acceptance criteria using `assign_team_steps`. Only the next specialist runs. It receives previous outputs and tool receipts and reports `done` or `blocked` using `report_team_step`. The manager must call `review_team_step` to accept, correct/retry, or block before the next step runs. These tools are scoped to the active participant conversation; specialists cannot approve their own results. Acceptance is an agent assessment of evidence, not independent proof of a real-world outcome.

The board displays the assignments and their status. At most 12 steps and two attempts per step are allowed, with a 50-turn overall bound. Missing reports or unresolved blockers stop dependent work. A manager must not retry an irreversible action with an uncertain outcome. Completed actions are not replayed automatically after a stop or restart. The final manager response remains on the board; the originating chat can inspect it with `read_team_board`.

## Unattended local actions

In **Settings → Local PC confirmations**, select **Enable unattended actions** to skip native LocalTools confirmation dialogs. This covers overwrites, moves, recycling, desktop clicks, typing, key presses, launching apps, opening URLs/paths, and browser confirmation calls including sends. Use **Turn confirmations back on** to restore prompts. The setting is shared by all Dots using the bundled local stdio LocalTools server. Existing browser site exceptions still apply in confirm mode. Other MCP servers and isolated computer-service approval systems are not changed by this setting.

The owner-authenticated endpoints are `GET /api/confirmation-policy` and `PUT /api/confirmation-policy` with `{ "mode": "confirm" }` or `{ "mode": "unattended" }`. No agent tool changes this setting. The policy is stored in `data/confirmation-policy.json` (or `LOCALTOOLS_CONFIRMATION_POLICY`) and is read on every action. Tool permissions, path restrictions, Pause and browser takeover remain active. Existing dialogs must be answered or cancelled. Malformed policy falls back to confirmations; absent policy uses `LOCALTOOLS_CONFIRM`, which defaults to confirmations enabled.

## Discussion mode

Open the side panel's **Team** tab, enter an objective, select 2–8 Dots and a decision maker, and start a discussion. Dots take turns automatically for 1–5 rounds. The decision maker goes last each round and produces the final decision at the end. A decision represents the lead's conclusion, not unanimous agreement or proof that all proposed actions were executed.

Each participant gets a saved conversation and the shared findings from earlier turns. The board, interim messages, final decision and errors are stored in SQLite. Expand Discussion to inspect the evidence and disagreements. Stop discussion cancels the current turn and prevents further turns; it does not undo completed actions. Interrupted discussions become blocked after a restart and are not replayed automatically.

Dots with delegation enabled can call `start_team_board` with an objective, participant IDs, lead ID and round count. `list_specialists` returns IDs. All Dots can use `list_team_boards` and `read_team_board`; active participant conversations can call `post_team_message`. Final turn responses are posted automatically. Board turns cannot start nested boards or delegate further; only one board runs at a time. Existing model timeouts, pause controls, permissions and tool confirmations remain in force.

Owner-authenticated API: `GET /api/team-board`, `POST /api/team-board`, `GET /api/team-board/:id`, and `POST /api/team-board/:id/stop`. The API uses the same owner-token and origin checks as the rest of OpenDots.

## Adjusting execution

To repair a lost completion report on an inactive blocked/stopped workflow, the owner API accepts `POST /api/team-board/:id/steps/:stepId/report` with `{ "result": "...", "evidence": "..." }`. It restores the step to review, preserves execution attempt counts and records an audit message. It neither accepts the claim nor resumes execution. Identical repeated submissions are idempotent; active workflows cannot be edited through this endpoint.

Assignment, report and review tools resolve the board from the participant conversation on the server; the model supplies a step ID where needed, never a board ID. Dot turn timeouts measure inactivity and refresh on model output or tool results, so productive work can continue beyond ten minutes. Individual tool timeouts and separately scheduled task deadlines still apply.

Successful assignment, report and review tools hand control straight back to the scheduler without an extra model response. A second board mutation in the same turn is refused. Repeating an identical task for the same specialist preserves its existing step and does not consume another slot; represent intentional repetitions as distinct numbered tasks. Scheduled specialists use tool confirmations rather than asking for a second approval in chat.

Individual Dot turns allow up to 100 model/tool cycles by default (`MAX_AGENT_ITERATIONS`). Reaching that limit reports an explicit incomplete-task error; it never silently reports a finished turn. The existing turn timeout and owner stop controls still apply. This replaces the former ten-cycle cutoff that could leave ordinary chat automation unfinished.

Workflows continue from saved assignments and reports when a response stream fails after posting them. An interrupted specialist turn without a report goes to manager review with an uncertain outcome; the action is not automatically repeated. Managers get up to three consecutive turns without progress to repair missing assignments or reviews. An explicit blocker, owner stop, permission failure or workflow limit still stops execution with the saved results intact.

Workflow managers have only assignment, review, board-read and board-message tools during scheduled turns. Browser, desktop and file actions belong to the assigned specialist. Participant conversations are scheduler-owned: sending an ordinary chat retry to one produces an explicit error instead of executing outside the board. Inspect the board and create a new task with explicit remaining scope after a failure; uncertain or completed actions are not replayed. A turn timeout reports an explicit error and suggests checking the last tool result and any open confirmation.

Use **Execution guidance** to specify scope, responsibilities and expected evidence. For example: “Inspect the OpenDots project, focus on src/client, and report only verified findings. Files locates the relevant code; Developer diagnoses the bug.” Participants receive the OpenDots project root and teammate roles. A team turn asks for a compact Finding / Evidence / Blocker / Next action report, uses exact available tool names, and avoids repeating unsuccessful tool calls. These instructions improve consistency but do not guarantee a model will follow them.

While a board is running, **Adjust execution → Update direction** replaces its guidance for subsequent turns. It does not interrupt the current action. The correction is recorded in the discussion. If the last turn is already running, a further round is added (up to five); at the limit, stop and start a board with the revised direction. This is also available as `POST /api/team-board/:id/guidance` with `{ "guidance": "..." }`.

The board shares bounded excerpts of actual tool results separately from agent reports. A successful tool invocation is not proof the whole task succeeded: errors in those results remain errors. New board conversations are excluded from memory indexing, and team memory searches exclude old board conversations, so agents do not treat repeated board narration as independent evidence.

## Improving OpenDots

Choose **Improve OpenDots**, select a participant with Code changes enabled, and choose a different decision maker. Describe the expected behavior precisely: “Add a confirmation before deleting a task. Cancel must leave the task untouched; confirm must delete it once.” Other specialists contribute findings; the Developer runs before the decision maker, implements the change in a separate worktree, runs validation and submits a review. Subsequent rounds can inspect the submitted change without creating duplicates.

The board is marked **awaiting_review** only when the server finds a passing submitted review belonging to its Developer conversation. Agent claims alone cannot mark an improvement successful: without a review it is **blocked**. Use **Review changes** to inspect and apply the change. Apply requires confirmation, refuses failed validation, and requires a clean checkout. Restart OpenDots after applying server changes.

Code changes start from a committed checkpoint. If the project has uncommitted work, the Developer reports that blocker instead of working from an outdated commit. An unfinished worktree belongs to its originating conversation, survives restarts and cannot be silently replaced by another request. Continue that conversation to finish or explicitly discard it. Learned procedures and role-instruction proposals remain separate from code changes; instruction proposals still appear in Dot settings for approval.
