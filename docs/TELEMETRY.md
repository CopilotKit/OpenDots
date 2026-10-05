# Intelligence signup and OpenDots usage tracking

OpenDots uses the CopilotKit SDK's existing telemetry transport. There is no
separate PostHog SDK or PostHog key to configure in this application.

## Configure the server

Run these commands from the OpenDots root:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

Keep both generated values in the server environment:

| Variable                   | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `CPK_INTELLIGENCE_API_KEY` | Server-only project key for persistent conversations.                                      |
| `CPK_TELEMETRY_ID`         | CLI-issued project binding that the telemetry sink can resolve to an Intelligence account. |

Deploy the values for the selected project together. Do not generate your own
telemetry ID, reuse another project's ID, or put either value in client-side
variables. An API key alone does not give runtime telemetry a resolvable identity.
If the CLI reports an identity provisioning failure, resolve that failure and
run project selection again before claiming account attribution works.

Docker Compose forwards `CPK_TELEMETRY_ID` from `.env` into the app container.
For other deployment environments, copy the CLI-generated identity and its
matching project key into the server environment, then restart the server.
Keep the identity server-side. Leave `OWNER_ID` and conversation/thread IDs
unchanged; they scope app data and are not the signup account identity.

The SDK sends existing runtime events to
`https://telemetry.copilotkit.ai/ingest`. OpenDots adds
`accessibility_title: "OpenDots"`. The current SDK defaults to full sampling
(`1`), and Docker Compose uses the same default. An explicit
`COPILOTKIT_TELEMETRY_SAMPLE_RATE` override is respected.

Remove old deployment settings that disable telemetry if tracking is desired.
To opt out, set either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`
and restart the API. Both variables accept `true` or `1`. The `npm test` command disables telemetry for ordinary automated fixtures.

## What the events measure

- `intelligence_signup`: an Intelligence account created in Clerk, emitted by
  the existing backend sync with the Clerk user ID as its PostHog `distinct_id`.
- `oss.runtime.instance_created`: the OpenDots runtime handler was created.
- `oss.runtime.copilot_request_created`: a request reached the runtime; this is
  usage evidence, not proof of a successful model answer.

The sink enriches runtime events with `telemetry_id`, and with `clerk_user_id`
when that identity resolves. Runtime and signup events can have different
PostHog `distinct_id` values: join the runtime `clerk_user_id` property to the
signup `distinct_id` rather than assuming a standard person funnel joins them.

This connects completed signups to OpenDots usage. It does not prove OpenDots
was the acquisition source: the account might predate OpenDots. Measuring
acquisition requires carrying a source through the Intelligence signup flow.
OpenDots does not emit a duplicate signup event on startup, login or key entry.

## Validate in PostHog

After deploying, restart the API and make one chat request. In
[PostHog project 26816](https://eu.posthog.com/project/26816), run:

```sql
SELECT event, timestamp, distinct_id,
       properties.accessibility_title AS app,
       properties.telemetry_id AS telemetry_id,
       properties.clerk_user_id AS clerk_user_id
FROM events
WHERE event IN (
    'oss.runtime.instance_created',
    'oss.runtime.copilot_request_created'
  )
  AND properties.accessibility_title = 'OpenDots'
  AND timestamp >= now() - INTERVAL 1 DAY
ORDER BY timestamp DESC
LIMIT 20
```

Confirm the tag, the expected telemetry identity and the resolved Clerk subject.
Then find that subject's `intelligence_signup` event. To count accounts signed
up in the last 30 days that also used OpenDots in that period:

Run the saved [signup-account query](telemetry/opendots-signups.hogql.sql).
It joins requests to signup accounts by Clerk ID. If a request lacks Clerk
enrichment, it uses the latest resolved startup/runtime event with the same
telemetry identity in the reporting window. This avoids assuming every request
has a resolved account, and avoids joining unrelated installations by IP or
PostHog person ID. The [daily usage query](telemetry/opendots-usage.hogql.sql)
uses the same identity lookup. Both queries exclude marked validation events
from requests and identity lookups.

An HTTP `202` from ingest alone does not prove PostHog delivery. If the event
or identity enrichment is missing, check the deployed server environment and
the `TelemetrySinkIngest` / `TelemetrySinkFanout` CloudWatch logs. The canonical
reporting surface is [dashboard 664553](https://eu.posthog.com/project/26816/dashboard/664553).

## Local verification

`npm test` disables production telemetry for ordinary fixtures. The telemetry
tests start fresh processes, intercept SDK fetch calls before importing it,
and check the OpenDots tag, CLI-issued identity header, full sampling, explicit
sampling override, both opt-outs and absence of the project key in the payload.
These checks prove the local SDK contract; production delivery and identity
resolution require the PostHog checks above. Internal `@copilotkit.ai` accounts
are excluded from signup sync, so validate a new external signup separately.

Ask the reporting owner to add the OpenDots filter and Clerk-ID join to
its reporting rule. The query counts signup accounts associated with usage,
not signups caused by the template. Local Intelligence evaluation also requires
CopilotKit sign-in, but a runtime event by itself does not establish a new signup.

## Reporting queries and validation evidence

The saved [signup-account query](telemetry/opendots-signups.hogql.sql) and
[daily usage query](telemetry/opendots-usage.hogql.sql) exclude marked validation
probes. The [setup-event query](telemetry/opendots-setup.hogql.sql) and
[installation conversion query](telemetry/opendots-setup-conversion.hogql.sql)
report the [browser setup flow](SETUP-TELEMETRY.md). All four queries executed
successfully against the production PostHog query API. Use these as the OpenDots
reporting rule in PostHog. Request counts are
attempts, including requests rejected by the SDK; they are not successful answers.

On October 5, 2026, a live SDK probe using the CLI-selected `opendots` project
sent `oss.runtime.instance_created` and `oss.runtime.copilot_request_created`
to the production sink. Both returned HTTP `202` with marker
`opendots-validation-be790d6a-ff3e-4ce9-be30-5e3741ffc707`. The request was stopped
at SDK body validation before an agent ran. It made no model call and created
no signup or customer conversation.

Authenticated PostHog queries returned one event of each type, both with a
telemetry identity and resolved Clerk user ID. Both events resolved to a staff
account (`@copilotkit.ai`), which signup sync excludes; the matching signup
count was therefore zero. This proves live SDK delivery and account resolution,
not a new external signup. The saved reporting queries both executed successfully:
zero signup accounts and no non-validation daily usage rows at validation time.

The validation key is permitted to execute HogQL but cannot read dashboard
664553 (`403`, missing `dashboard:read`). The queries are prepared and executed,
but were not saved as dashboard charts. Saving the reporting rule requires
dashboard and insight read/write scopes, or the reporting owner's intervention.

A marked `oss.runtime.setup_step_viewed` from the production setup emitter also
reached PostHog with its installation UUID:
`opendots-setup-validation-1ddf8b49-4d6a-434e-b345-4982d48cd9a5`. Setup events
do not receive Clerk account enrichment from the shared fanout; only the two
exact runtime event types above do. Join setup and runtime by their shared
`installation_id` to associate setup with account-resolved usage. The runtime
continues to use the CLI identity as its transport identity. Activation and
abandonment edge cases are validated locally, not fabricated in production.

The combined updated probe
`opendots-validation-70c8067c-aa54-48c5-8d37-725baca262cf` delivered a startup,
request, and setup-view event with one shared installation UUID. Startup
resolved to the Clerk account; the request retained telemetry identity but
lacked Clerk enrichment. This is why reporting uses the same-identity startup
lookup. A missing request Clerk ID alone is not evidence that the template
lost its identity. The shared sink's dependency resolution is separate from
this template's transport wiring.
