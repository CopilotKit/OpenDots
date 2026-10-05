# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and thread bindings in SQLite and connects to your configured conversation, model, and messaging services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

During `npm run dev`, both http://localhost:5173 and http://127.0.0.1:5173 are allowed browser origins. The UI sends API requests through Vite's `/api` proxy. To use a different proxy or custom domain, set `APP_ORIGIN` to one exact origin or a comma-separated list, for example `APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`. An explicit value replaces the development defaults. Origins must match the scheme, hostname, and port exactly; omit paths and trailing slashes. Whitespace around list entries is trimmed and empty entries are ignored. Outside development, leaving `APP_ORIGIN` unset requires the browser origin to match the request URL's origin. This setting preserves cross-site request blocking; it does not enable direct cross-origin browser access to the API.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversation services

OpenDots requires CopilotKit Intelligence for conversations. Choose local evaluation below, a licensed [self-hosted deployment](https://docs.copilotkit.ai/intelligence/self-hosting), or hosted Intelligence. Pages and workspace metadata remain in SQLite; conversation history is stored separately. See [Data and privacy](../README.md#data-and-privacy).

### Hosted Intelligence

To get a hosted project key, run these commands in the OpenDots folder after `cp .env.example .env`:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

`login` opens the browser to sign in or create an account. `project select` lets you select or create a project, and writes a project-scoped key to `.env` as `CPK_INTELLIGENCE_API_KEY`. It removes an `INTELLIGENCE_API_KEY` line, so that the file holds one credential. Use the same project for Slack and Automatic Learning below.

Do not run `copilotkit onboard` in this folder. Onboarding is for apps that do not have CopilotKit yet. OpenDots already has its integration.

### Local Intelligence evaluation

The [local evaluation preview](https://docs.copilotkit.ai/intelligence/self-hosting-local) runs Intelligence in Docker Desktop on macOS. Allocate at least 4 CPUs, 12 GiB RAM, and 40 GiB free storage. OpenDots needs Node.js 24. A CopilotKit account is required; the free Developer plan qualifies for a renewable 30-day evaluation license. This is not a production installation.

Run from the OpenDots folder after `cp .env.example .env`, with Docker Desktop running:

```sh
npx copilotkit@latest login
npx copilotkit@latest local setup
npx copilotkit@latest local connect
npx copilotkit@latest local connect --approve-connection
```

`local connect` previews the changes; the approved command writes the local API URL, gateway WebSocket URL, and project key to `.env`. OpenDots accepts these directly. Do not run `project select` afterward: it selects a hosted project. Add `OPENAI_API_KEY` and `OPENAI_MODEL` for the app, then restart `npm run dev`. Setup's Learning model is separate from the app's model.

Send a message and verify it appears in the local dashboard (`npx copilotkit@latest local login`). Use `local status` to inspect service health. Threads, Automatic Learning, and Channels are included; User Memory and Product Analytics are not. Channels require a public HTTPS address reachable by Slack or Teams.

To restore the previous app connection, run `npx copilotkit@latest local cancel` and restart the app. This keeps the stack and its data. Use `local stop` to stop the stack, or `local renew` to renew its evaluation license. Existing hosted conversations are not copied into the local project.

For this preview, run OpenDots directly on your Mac with `npm run dev`; Intelligence runs in Docker. The CLI's `localhost` URLs do not work from an OpenDots container. A containerized app needs an API address reachable from its container and a gateway address reachable from both the server and the browser, because the runtime advertises that gateway to browser clients. Changing the gateway to a Docker-only hostname is not sufficient.

### Connection settings

Edit `.env` on the server and restart after changes:

| Variable                                             | Purpose                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `INTELLIGENCE_API_KEY`                               | Project credential for conversation persistence                        |
| `INTELLIGENCE_API_URL`                               | API endpoint override for your Intelligence deployment                 |
| `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_WS_URL` | Gateway WebSocket override (CLI name preferred; legacy name supported) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`                     | Model credential and model identifier                                  |
| `OPENAI_BASE_URL`                                    | Compatible model API endpoint                                          |
| `OWNER_ID`                                           | Stable identity used for this deployment's conversations               |
| `DATABASE_PATH`                                      | SQLite file containing pages, workspace and work metadata              |
| `OWNER_TOKEN`                                        | Application access token; required for external bindings               |
| `APP_ORIGIN`                                         | Comma-separated exact browser origins for a proxy or custom domain     |

`npx copilotkit project select` deletes an `INTELLIGENCE_API_KEY` line and writes the same credential as `CPK_INTELLIGENCE_API_KEY`. The server reads either name. A non-empty `CPK_INTELLIGENCE_API_KEY` takes precedence over `INTELLIGENCE_API_KEY`.

A non-empty `INTELLIGENCE_GATEWAY_WS_URL` takes precedence over `INTELLIGENCE_WS_URL`. Without either WebSocket override, OpenDots uses the hosted gateway. Set both the API and gateway endpoints when connecting a self-hosted deployment.

The model environment variable names follow the configured provider adapter. Provider credentials belong in `.env`, not client-side variables or source code. Conversation history lives in the configured Intelligence project; copying the SQLite file alone does not back up that history.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, deleting a page (its subpages move up to the deleted page's parent), and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a CopilotKit Thread for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up both storage layers: SQLite contains page content and thread bindings; the Intelligence project contains conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Browser tool

Parallel is selected by default (`WEB_SEARCH_PROVIDER=parallel`). Live research needs the model configuration, but no browser worker. An optional server-side `PARALLEL_API_KEY` enables authenticated usage and higher limits. The anonymous MCP endpoint is free for light use. Queries, selected URLs, research objectives and a stable session identifier go to Parallel. See [public-web research](../README.md#public-web-research) for data sharing, permissions and limitations.

Set `WEB_SEARCH_PROVIDER=disabled` to turn off these research tools, or `WEB_SEARCH_PROVIDER=browser` for the existing URL-only reader. The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Slack

OpenDots uses `@copilotkit/channels` with a managed Slack connection, following the runtime and channel pattern in [OpenTag](https://github.com/CopilotKit/OpenTag). The application declares the channel and its specialist agent; Intelligence manages the Slack adapter and delivery. You do not need a separate Slack webhook server or Socket Mode connection in OpenDots.

The CLI project-selection commands below are for hosted Intelligence. For local evaluation, configure Channels in the local dashboard and follow the [local Channels requirements](https://docs.copilotkit.ai/intelligence/self-hosting-local#connect-slack-or-microsoft-teams), including a public HTTPS address. Do not replace the local project key with `project select`.

### Create the managed channel

Select the same Intelligence project used by this application, then create a uniquely named channel:

```sh
npx --yes copilotkit@latest project select
npx --yes copilotkit@latest channels add --name opendots --display-name "OpenDots" --adapter slack --json
```

Follow the CLI's returned `nextAction` to create the Slack app from its generated manifest, supply credentials through the managed setup flow, and run its `resumeCommand`. A `blocked` response means a Slack-console step is still needed; a `failed` response must be resolved before continuing. Keep Socket Mode off. Install or reinstall the generated app in your workspace with its requested scopes. Use a distinct channel name for separate deployments so they do not compete for deliveries.

See [OpenTag's setup guide](https://github.com/CopilotKit/OpenTag/blob/main/setup.md) for the Slack-console walkthrough. Slack bot tokens and signing secrets belong in the managed adapter configuration, not the browser or this application's `.env`.

### Connect a specialist

Configure the application server's `.env` alongside its Intelligence and model credentials:

```dotenv
SLACK_CHANNEL_NAME=opendots
SLACK_TEAM_ID=T_REPLACE_WITH_WORKSPACE_ID
SLACK_USER_IDS=U_REPLACE_WITH_YOUR_USER_ID
SLACK_DOT_ID=REPLACE_WITH_DOT_ID
```

`SLACK_CHANNEL_NAME` must exactly match the managed channel name, not a Slack conversation name such as `#general`. OpenTag calls this setting `INTELLIGENCE_CHANNEL_NAME`; OpenDots uses `SLACK_CHANNEL_NAME`. `SLACK_TEAM_ID` and the comma-separated `SLACK_USER_IDS` restrict who may invoke the specialist. `SLACK_DOT_ID` selects an existing Dot; find IDs in the authenticated `/api/workspace` response. If omitted, it defaults to the initial Dot.

Restart OpenDots after changing environment settings and inspect Slack status in Settings & setup. Channel activation must complete before trying a message. Mention the installed bot in a channel it can access; subsequent messages in that followed thread go to the same specialist. Unrelated threads, bot events, edits, deletions, and users outside the allowlist do not start agent runs. Editing a message to add a mention is not supported; send a new message instead.

This template maps permitted Slack users to the single OpenDots owner. Replies are visible to the Slack conversation's audience, so choose the specialist's Space access and permitted tools accordingly. This is not a multi-user identity model.

### Verify your deployment

From an allowed user, mention the bot and verify a response in the same Slack thread. Reply in that thread and confirm continuity. Check that an unrelated thread and an unapproved user cannot invoke it. Pause the assistant in OpenDots and verify that a permitted request receives a paused notice. Check Settings & setup for channel connection failures.

Local tests exercise channel behavior with fixtures. A live Slack mention/reply remains unverified until you provision the managed connection and model credentials. [Channels SDK documentation](https://github.com/CopilotKit/channels-sdk) describes extending the adapter and channel behavior.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Application metadata lives in the `opendots-data` volume.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Automatic Learning

OpenDots connects [CopilotKit Automatic Learning](https://docs.copilotkit.ai/learning)
to individual Dots. It uses the server-side Intelligence credential
(`CPK_INTELLIGENCE_API_KEY` or `INTELLIGENCE_API_KEY`) and optional
`INTELLIGENCE_API_URL`; no additional model key or frontend key is needed.

1. Open **Learning** in the same Intelligence project and create a container for
   one focused workflow, such as `research-workflow`. IDs use 1–64 lowercase
   letters, numbers, and single hyphens.
2. In OpenDots, edit the Dot and enter that ID under **Automatic Learning**.
   Saving the ID configures routing; it does not create or verify the remote container.
3. Start new conversations and complete related workflows. Each conversation keeps
   the container assigned when it was created. Existing conversations, including
   ones created before this integration, are not enrolled retroactively. Changing
   or clearing the Dot's ID affects only new conversations. This applies to page
   chat, scheduled and voice compute in those conversations, and new Slack threads.
4. In Intelligence, inspect the evidence, run Learning manually or use its schedule,
   and review and publish proposed skills. The default automatic threshold is 15
   eligible threads; use the readiness count shown in your deployment.
5. Enable **Skill delivery** on the Intelligence container, then enable **Use
   published skills** in the Dot's settings. Start a new turn in an enrolled
   conversation. BuiltInAgent loads the latest verified published catalog; its
   TanStack AI factory runs the model and exposes `copilotkit_load_skill` and `copilotkit_read_skill_file`.
   The model decides which relevant skills to load. Check the run's tool calls to
   verify actual use; saving settings alone does not establish connectivity.

Skill delivery always uses the conversation's original container, even after the
Dot is pointed at another container. The Dot's delivery checkbox applies to all its
conversations. Unchecking it stops delivery on subsequent turns; changing Learning
settings also stops active work. Conversations without a container do not request
skills. Existing research, memory, page, and computer permissions still apply.

Ingestion and delivery are separate. Clearing the container does not unenroll older
conversations; pause Learning in Intelligence to stop its analysis. Turning off
delivery does not stop evidence collection. A delivery denial or an unavailable
initial skill snapshot fails the turn rather than silently continuing without the
configured skills. Restore delivery or uncheck **Use published skills** to continue
without them. Skills require review and publication in Intelligence; OpenDots does
not automatically approve them.

The integration uses an explicit container list, so ambient
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` and `CPK_INTELLIGENCE_SKILLS_REVISION`
variables do not override a conversation's configuration. Self-hosted Intelligence
must support the [skill delivery endpoints](https://docs.copilotkit.ai/intelligence/learned-skills).

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model, Intelligence, Slack, and voice verification requires your own configured services.
