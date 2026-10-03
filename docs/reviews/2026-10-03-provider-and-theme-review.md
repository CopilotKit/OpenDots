# Provider and theme review

Review date: 2026-10-03. Branch: `dev`.

Verdict: **SHIP for pull request and CI review**. The final review has no remaining critical, major, or minor findings in the requested scope.

## Repairs and evidence

| Area                   | Final behavior                                                                                                                                                                                                         | Evidence                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Provider routing       | The selected slot controls readiness. Unknown providers, missing keys or models, invalid auth modes, and retired models produce actionable errors. GPT-5.5 becomes unavailable on 2026-10-15 UTC for OpenAI and Codex. | `tests/models.test.ts`, `tests/setup.test.ts`, `tests/research.test.ts`                                        |
| SDK integration        | Installed TanStack packages form a compatible family. Real package types replace ambient shims. Claude and Codex receive their typed options and sandbox workspace projection.                                         | Type checking, build, `tests/harness.test.ts`                                                                  |
| Subscription login     | Native subscription status is required. API-key login is refused. Auth checks and model turns use the same Windows home fallback.                                                                                      | Actual subprocess fixtures using the installed SDK, including missing CLI and login refusal                    |
| Runtime boundaries     | Subscription providers require loopback development outside containers. Working directories are separate for each Dot and conversation. The CLI retains host filesystem permissions.                                   | Runtime guard tests, hashed-directory tests, `docs/SETUP.md`                                                   |
| Tools and cancellation | The actual MCP bridge creates authorized pages and refuses foreign Spaces. Pause, cancellation, stalled login, and already-aborted login checks stop without launching further work.                                   | 26 harness regressions, child PID checks, and heartbeat checks                                                 |
| Error privacy          | Harness errors contain only a bounded message, event type, thread ID, and run ID. App-authored setup guidance survives SDK serialization. Each failure emits one error event.                                          | Failed-turn fixtures with nested synthetic secrets and observable error propagation                            |
| Environment protection | Varlock validates optional configuration and sensitive credentials, redacts logs, and blocks secret responses. Its serialized environment and service credentials are removed from CLI child environments.             | 11 environment regressions and harness child environment receipts                                              |
| Launch and containers  | The cross-platform wrapper disables the Varlock telemetry crash and preserves child exit codes. Both runtime images contain the schema and wrapper.                                                                    | Wrapper subprocess regressions, environment check, Dockerfile inspection, and Compose configuration validation |
| HTTP providers         | Anthropic uses `x-api-key` and its version header without Bearer authorization. OpenAI, custom, and Cline keep their Bearer requests and correct endpoints.                                                            | Installed SDK request capture in `tests/model-adapters.test.ts` and research regressions                       |
| Themes and storage     | All five palettes cover shell and editor controls. Chat code surfaces use matching foregrounds. The document chat dock has a focus cue. Prepaint works under CSP, and denied storage preserves app operation.          | Built-app browser verification, theme tests, and API storage regressions                                       |

## Final validation

All requested checks completed successfully after installation:

| Check                                                                        | Result                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm install --cache artifacts/npm-cache`                                    | Exit 0. Lockfile updated. Installation audit reported zero vulnerabilities.                              |
| `npm run env:check`                                                          | Exit 0. No credentials configured in the checked setup.                                                  |
| `npm run typecheck`                                                          | Exit 0.                                                                                                  |
| `npm run lint`                                                               | Exit 0.                                                                                                  |
| `npm test -- --reporter=json --outputFile=artifacts/test-final.json`         | Exit 0. All 267 tests pass across 41 files, including all 26 harness regressions.                        |
| `npm run build`                                                              | Exit 0. Client and server compile. Vite reports a large-chunk warning.                                   |
| `npm run verify:themes`                                                      | Exit 0. 143 rendered scans, 7,616 contrast checks, 33 screenshots, and zero failed scans.                |
| `npm run check-format -- "!docs/handoffs/2026-10-03-subscription-bridge/**"` | Exit 0. The exclusion preserves an unrelated, untracked imported handoff and upstream protocol snapshot. |
| `docker compose --profile browser config --quiet`                            | Exit 0 with a synthetic owner token, restored afterward.                                                 |
| `git diff --check`                                                           | Exit 0.                                                                                                  |

The browser fixture renders actual user and assistant Markdown through the built React app and the SDK's local conversation persistence. It verifies fenced code, inline code, links, lists, and quotations at 320, 375, and 1440 pixels. It also checks typed document chat, focus cues, persistence, blocked storage, and prepaint before the React bundle runs. It makes no external provider calls.

Machine-readable receipts and screenshots remain in the ignored `artifacts/` directory:

- `artifacts/test-final.json`
- `artifacts/theme-verification/receipt.json`
- `artifacts/theme-verification/*.png`
- `artifacts/env-check-final.log`
- `artifacts/build-final.log`

## Verification limits

Fixtures exercise installed SDKs and real local subprocesses. They do not establish live Claude or Codex subscription access, model availability, or service billing. Live native account turns on Windows remain unverified. To cover them, configure one subscription provider, log in through its native CLI, run `npm run dev`, and send a Dot message. Repeat for the other provider and verify pause and cancellation.

Docker configuration and image contents were reviewed, but Docker's Linux daemon is unavailable on this machine. No image build or container startup was verified. When the daemon is available, use a fixture owner token and run `docker compose build` followed by a local startup check.

This receipt records local verification before PR publication. The PR description records GitHub delivery and CI status. Local `prod` tracks `origin/main`. The unrelated imported handoff directory remains untouched and is outside this delivery.
