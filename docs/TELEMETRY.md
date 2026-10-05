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

```sql
SELECT count(DISTINCT signup.distinct_id) AS signups_with_opendots_usage
FROM events AS signup
INNER JOIN (
  SELECT DISTINCT properties.clerk_user_id AS clerk_user_id
  FROM events
  WHERE event = 'oss.runtime.copilot_request_created'
    AND properties.accessibility_title = 'OpenDots'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND notEmpty(toString(properties.clerk_user_id))
) AS usage ON signup.distinct_id = usage.clerk_user_id
WHERE signup.event = 'intelligence_signup'
  AND signup.timestamp >= now() - INTERVAL 30 DAY
```

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
