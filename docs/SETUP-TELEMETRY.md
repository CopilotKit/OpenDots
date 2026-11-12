# Browser setup telemetry

OpenDots tracks its existing browser setup flow through the server's CopilotKit ingest contract. This is the web distribution; OpenDots has no native installer, engine installation, Windows prerequisite, image-pull wizard, or model/harness picker. Those desktop events are not applicable.

Telemetry is enabled by default. Either `DO_NOT_TRACK=true|1` or `COPILOTKIT_TELEMETRY_DISABLED=true|1` disables the setup emitter and runtime. Restart after changing the server environment. Opt-out deletes the setup tracking row, including its pending queue and fallback installation identity. It does not change the owner, conversations, or application settings. Sampling rate zero also suppresses setup events.

| Event                           | Closed properties                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `oss.runtime.setup_step_viewed` | `kind=step_viewed`, step: `setup_required`, `ready`, `settings`                                                      |
| `oss.runtime.setup_failed`      | `kind=setup_failed`, step enum, error class: `configuration_missing`, `assistant_run_failed`, `channel_start_failed` |
| `oss.runtime.setup_activated`   | `kind=activated`                                                                                                     |
| `oss.runtime.setup_abandoned`   | `kind=setup_abandoned`, last step enum                                                                               |

`ready` means required server configuration exists. Activation requires an assistant message with nonempty streamed text and a successful AG-UI `RUN_FINISHED`, with no run error, abort, or timeout. It is recorded once per installation and remains deduplicated across server restarts. User messages, partial answers, tool-only runs, and configuration readiness do not activate the installation. Server-managed conversations, including Slack when configured, share this installation activation.

The authenticated `/api/setup-telemetry` route accepts only strict step-view and abandonment objects. It rejects unknown keys, invalid steps, arbitrary properties, client-forged activation/failure, and readiness inconsistent with server state. Existing owner-token, origin, cross-site, content-type, and body-size guards apply. Settings visibility does not expose environment configuration values.

Metadata names OpenDots, `opendots_distribution=web`, numeric release `opendots_version=0.1.0`, `runtime_env=node`, server platform (`macos|windows|linux|other`) and architecture (`aarch64|x86_64|other`), and a random persistent `installation_id`. Server platform identifies the server, including its container; it does not infer the browser OS. There are no prompts, answers, raw errors, keys, URLs, file paths, model names, emails, owner IDs, browser user agents, or machine-derived identifiers in setup events.

The current nonblank `CPK_TELEMETRY_ID` takes precedence as the ingest header and runtime `telemetryId`, preserving the CLI project/account identity. If absent, both use the persistent random installation UUID. The installation UUID remains separate metadata even when the CLI identity is present. Removing the CLI variable returns to the installation fallback. The runtime receives matching metadata through `telemetryProperties`; no PostHog SDK, public capture key, or separate signup event is added.

Events persist in the existing SQLite database before delivery. The queue holds at most 256 events, dropping oldest entries on overflow. UUID event IDs and Unix-second timestamps survive replay and retries. Delivery starts with server startup, retries every 15 seconds, and preserves events after a network or HTTP failure. Each pass has a two-second budget with a 1.5-second per-request timeout; shutdown delivery therefore finishes within approximately 3.5 seconds and leaves remaining events for restart. Diagnostics use bounded categories and never include transport exception details.

Browser `pagehide` sends a best-effort authenticated keepalive abandonment event. Accepted abandonment clears the tracked step; shutdown and restart recover abandonment from an unfinished persisted step when needed. A closed tab, killed browser, inaccessible server, or failed browser-to-server request may lose an event before it reaches SQLite. Recovered abandonment describes the last observed installation setup step; it is not a definitive measure of tab exits, especially with concurrent tabs. HTTP ingest acknowledgement alone is not evidence of downstream PostHog acceptance.

Local regression coverage includes offline replay across reopened databases, stable event IDs/identity, timestamp units, queue bounds, both opt-out variables and values, fallback/CLI precedence, recovered abandonment, activation deduplication, agent success/startup failures, assistant-role gating, timeout/abort suppression, bounded shutdown, schema rejection, and authenticated origin-protected routing. Tests intercept transports or inject a local recorder and do not send validation events to production:

```sh
DO_NOT_TRACK=1 npm exec vitest run tests/setup-telemetry.test.ts tests/dot-agent-channel.test.ts tests/telemetry.test.ts tests/app.test.ts
npm run typecheck
```

Production delivery and PostHog attribution are separate from these local checks; see [TELEMETRY.md](TELEMETRY.md) for live validation and reporting.
