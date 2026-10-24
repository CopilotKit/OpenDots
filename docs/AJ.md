# AJ's doorway into OpenDots

AJ is the owner's voice assistant (`Desktop\AIVoice\Jvis`, notes in the vault under
`AJ/`). It is the front man: it reads the trading and betting report, hands tasks to
Dots, starts Pocket Option runs, and tells the owner about problems. These routes are
how it reaches OpenDots. AJ decides who may ask (admin voice, a spoken yes); the routes
enforce what must hold whoever asks.

Code: `src/server/aj-routes.ts`, `localtools/aj_report.py`, and the run guard in
`localtools/browser.py` (`run_limits`, `run_refusal`, `ACCOUNT_JS`). Tests:
`tests/aj-routes.test.ts`, `localtools/test_aj_report.py`.

The API's usual rules apply: localhost (or `APP_ORIGIN` hosts), and
`Authorization: Bearer <OWNER_TOKEN>` when `OWNER_TOKEN` is set.

## Routes

| Route | What it does |
|---|---|
| `GET /api/aj/report` | `{speech, details}`: every record in a few plain sentences (options paper records, sports paper bets, Pocket Option, scheduled jobs). |
| `GET /api/aj/news?since=SECONDS` | `{problems, finished}` since a time. Problems: failed scheduled jobs, alerts that need the owner (an options exit to press), unreadable records, AJ tasks that failed. Finished: AJ tasks that completed and Pocket Option runs that ended. |
| `GET /api/aj/dots` | The Dots and their tool groups. |
| `POST /api/aj/tasks {dot, task}` | Gives a Dot a task. `dot` is a name ("developer", "Site Mapper") or an id. Runs in the task queue, one at a time, in a new conversation titled "AJ: ...". |
| `GET /api/aj/tasks`, `GET /api/aj/tasks/:id` | Status and result. The result is the spoken part only: no reasoning block, only what follows "TASK COMPLETE:". |
| `POST /api/aj/tasks/:id/stop` | Cancels it. |
| `POST /api/aj/pocket` | Starts a Pocket Option run (below). |
| `GET /api/aj/pocket` | The run now (balance, profit, `speech`), or the last one and how it ended. |
| `POST /api/aj/pocket/stop` | Stops the run. |

## Pocket Option runs

`{account: "demo"|"real", market: "otc"|"real"|"any", goal, lossLimit, minutes = 120}`.
`goal` and `lossLimit` are dollars of profit and loss from the balance at the start.

- **Everything is named.** There is no default account, market, goal or loss limit.
- **Real money needs `confirmRealMoney: true`.** AJ sends it only after reading the
  account, goal and loss limit back to the owner and hearing yes.
- **The page must show the account named.** That's checked from the address
  (`/cabinet/demo-...` is demo) and the header ("QT Demo" / "QT Real"). If they
  disagree, the run is refused, and the run never switches accounts itself.
- **Nothing else may use the shared browser.** A run is refused while another Dot's
  browser task is queued or running, and browser Dots' tasks are refused during a run.
- **The run is the Trader Dot with a pinned goal:** "We have $B. Keep trading until the
  balance reaches $B+goal; stop if it falls below $B-loss." OpenDots' goal checker ends
  the run when the page's balance reaches either. The limits (account, market, end time)
  go into `localtools/output/trading-mode.json` under `run`. `browser.py` checks them
  before every trade and before every scan, and refuses a trade on the wrong account,
  the wrong market, or after the end time. A backstop aborts the run 3 minutes after
  the end time.
- **When a run ends,** for any reason, its limits are removed from the file. A restart
  during a run records it as interrupted.

## What is not done here

- AJ's own abilities (`trading_report`, `give_dot_a_task`, `check_on_task`,
  `start_pocket_run`, `pocket_run_status`) and speaking problems unasked are built in
  the Jvis repo, under AJ's rules (`aj/voice-changes`, never pushed).
- Order buttons on Robinhood and DraftKings stay owner-only (`order_guard.py`). AJ
  can't place those orders through any route here.
- Developer changes still go through review. AJ passes the instruction and reports the
  result.
