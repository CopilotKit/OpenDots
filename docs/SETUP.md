# Run the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and thread bindings in SQLite and connects to your configured conversation, model, and messaging services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
node -e "require('node:fs').copyFileSync('.env.example', '.env', require('node:fs').constants.COPYFILE_EXCL)"
npm run env:check
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. The copy command preserves an existing `.env`. Without service credentials, the app shows its setup state. Manual page editing remains available.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversation services

Edit `.env` on the server and restart after changes:

| Variable                                         | Purpose                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| `INTELLIGENCE_API_KEY`                           | Project credential for conversation persistence           |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_WS_URL`    | Endpoint overrides for your Intelligence deployment       |
| `MODEL_PROVIDER`                                 | openai, anthropic, cline-pass, claude-code, codex, custom |
| `OPENAI_API_KEY`, `OPENAI_MODEL`                 | Model credential and model identifier                     |
| `OPENAI_BASE_URL`                                | Compatible model API endpoint                             |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`           | Anthropic API credential and model identifier             |
| `ANTHROPIC_BASE_URL`                             | Anthropic-compatible endpoint, including `/v1`            |
| `CLINE_API_KEY`, `CLINE_MODEL`, `CLINE_BASE_URL` | Cline API credential, model, and endpoint                 |
| `CLAUDE_MODEL`, `CLAUDE_AUTH_MODE`               | Claude subscription CLI (`claude auth login`, local only) |
| `CODEX_MODEL`, `CODEX_AUTH_MODE`                 | ChatGPT subscription harness (`codex login`, local only)  |
| `CLAUDE_CWD`, `CODEX_CWD`                        | Optional local working directory for the selected CLI     |
| `CLAUDE_PERMISSION_MODE`                         | Claude CLI permission mode, default `acceptEdits`         |
| `OWNER_ID`                                       | Stable identity used for this deployment's conversations  |
| `DATABASE_PATH`                                  | SQLite file containing pages, workspace and work metadata |
| `OWNER_TOKEN`                                    | Application access token required for external bindings   |
| `APP_ORIGIN`                                     | Exact browser origin when using a proxy or custom domain  |

Provider credentials belong in the server's `.env`. Leave unused service keys empty. The selected model slot needs its own credential and model before chat can run. Conversation history lives in the configured Intelligence project. Copying SQLite alone does not back up that history.

Varlock loads and validates `.env.schema` before the app starts. The schema marks credential values as sensitive and enables runtime log redaction and HTTP response leak detection. These protections supplement access controls and do not protect arbitrary secrets outside the schema.

Use the installed Varlock CLI:

```sh
npm run env:check
npx --no-install varlock encrypt --file .env
npm run env:scan
```

Encryption prompts you to select sensitive plaintext values and stores encrypted resolver expressions in `.env`. Encryption keys and CLI login state belong to that machine. Do not copy encrypted values into a deployment expecting another machine to decrypt them. Provision deployment secrets through its own environment. See [Varlock encryption commands](https://varlock.dev/reference/cli/encryption/) and [runtime protections](https://varlock.dev/guides/secrets/).

### Model providers

Set a lowercase `MODEL_PROVIDER` and configure one slot. Use a model identifier accepted by that provider and your account. Provider suggestions in the UI do not establish model availability, price, or performance.

- For OpenAI, set `MODEL_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
- For an OpenAI-compatible endpoint, set `MODEL_PROVIDER=custom` and configure the `OPENAI_*` variables, including `OPENAI_BASE_URL`.
- For Anthropic, set `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL`. The endpoint defaults to `https://api.anthropic.com/v1`.
- For Cline, set `MODEL_PROVIDER=cline-pass`, `CLINE_API_KEY`, and `CLINE_MODEL`. Confirm account access and billing with the provider.
- For Claude subscription access, install Claude Code and run `claude auth login` on the app's machine. Set `MODEL_PROVIDER=claude-code`, `CLAUDE_AUTH_MODE=host`, and `CLAUDE_MODEL`.
- For ChatGPT subscription access, install Codex CLI and run `codex login` on the app's machine. Set `MODEL_PROVIDER=codex`, `CODEX_AUTH_MODE=host`, and `CODEX_MODEL`.

Subscription providers spawn a local CLI for Dot chat. Use `npm run dev`. Production and container startup refuse these providers. OpenDots uses the CLI's login state without copying subscription tokens into `.env`. CLI sessions and login state remain machine-local. Windows subscription execution and live account access remain unverified by fixture tests. Follow [Claude authentication](https://code.claude.com/docs/en/authentication) or [Codex authentication](https://developers.openai.com/codex/auth/) for account setup.

`CLAUDE_PERMISSION_MODE` accepts `default`, `acceptEdits`, `plan`, or `bypassPermissions`. Choose permissions for the working directory you grant the CLI. The app organizes per-Dot, per-conversation directories under `.opendots/harnesses/<provider>` or your configured working-directory base. These directories do not isolate the CLI from the host's files or operating-system permissions. Research briefs require an HTTPS API provider. Subscription providers support Dot chat only.

### Nature themes

Use the **Color theme** selector in the topbar to choose Meadow Light (default), Redwood Grove, Coastal Fog, Canyon Bloom, or Moonlit Alpine (dark). The browser saves your choice to `localStorage: opendots-theme`. Alpine auto-applies when the OS prefers dark and nothing is saved.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses. The save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot's settings in the sidebar. The server creates or reuses a CopilotKit Thread for that page and specialist. The Dot receives the saved page as context and can read, create, and edit pages in its authorized Spaces.

The page conversation uses that page's Space by default. Other chats use the Dot's default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes. A conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up both storage layers. SQLite contains page content and thread bindings. The Intelligence project contains conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Browser tool

Parallel is selected by default (`WEB_SEARCH_PROVIDER=parallel`). Live research needs the model configuration, but no browser worker. An optional server-side `PARALLEL_API_KEY` authenticates requests. Anonymous endpoint access follows the provider's usage policy. Queries, selected URLs, research objectives, and a stable session identifier go to Parallel. See [public-web research](../README.md#public-web-research) for data sharing, permissions, and limitations.

Set `WEB_SEARCH_PROVIDER=disabled` to turn off these research tools, or `WEB_SEARCH_PROVIDER=browser` for the existing URL-only reader. The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported. Provide a canonical public URL. This browser tool reads public pages.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool. Enable each Dot's required capabilities before use.

## Slack

OpenDots uses `@copilotkit/channels` with a managed Slack connection, following the runtime and channel pattern in [OpenTag](https://github.com/CopilotKit/OpenTag). The application declares the channel and its specialist agent. Intelligence manages the Slack adapter and delivery. You do not need a separate Slack webhook server or Socket Mode connection in OpenDots.

### Create the managed channel

Select the same Intelligence project used by this application, then create a uniquely named channel:

```sh
npx --yes copilotkit@latest project select
npx --yes copilotkit@latest channels add --name opendots --display-name "OpenDots" --adapter slack --json
```

Follow the CLI's returned `nextAction` to create the Slack app from its generated manifest, supply credentials through the managed setup flow, and run its `resumeCommand`. A `blocked` response means a Slack-console step is still needed. Resolve a `failed` response before continuing. Keep Socket Mode off. Install or reinstall the generated app in your workspace with its requested scopes. Use a distinct channel name for separate deployments so they do not compete for deliveries.

See [OpenTag's setup guide](https://github.com/CopilotKit/OpenTag/blob/main/setup.md) for the Slack-console walkthrough. Slack bot tokens and signing secrets belong in the managed adapter configuration, not the browser or this application's `.env`.

### Connect a specialist

Configure the application server's `.env` alongside its Intelligence and model credentials:

```dotenv
SLACK_CHANNEL_NAME=opendots
SLACK_TEAM_ID=T_REPLACE_WITH_WORKSPACE_ID
SLACK_USER_IDS=U_REPLACE_WITH_YOUR_USER_ID
SLACK_DOT_ID=REPLACE_WITH_DOT_ID
```

`SLACK_CHANNEL_NAME` must exactly match the managed channel name, not a Slack conversation name such as `#general`. OpenTag calls this setting `INTELLIGENCE_CHANNEL_NAME`. OpenDots uses `SLACK_CHANNEL_NAME`. `SLACK_TEAM_ID` and the comma-separated `SLACK_USER_IDS` restrict who may invoke the specialist. `SLACK_DOT_ID` selects an existing Dot. Find IDs in the authenticated `/api/workspace` response. If omitted, it defaults to the initial Dot.

Restart OpenDots after changing environment settings and inspect Slack status in Settings & setup. Channel activation must complete before trying a message. Mention the installed bot in a channel it can access. Subsequent messages in that followed thread go to the same specialist. Unrelated threads, bot events, edits, deletions, and users outside the allowlist do not start agent runs. Editing a message to add a mention is not supported. Send a new message instead.

This template maps permitted Slack users to the single OpenDots owner. Replies are visible to the Slack conversation's audience, so choose the specialist's Space access and permitted tools accordingly. This is not a multi-user identity model.

### Verify your deployment

From an allowed user, mention the bot and verify a response in the same Slack thread. Reply in that thread and confirm continuity. Check that an unrelated thread and an unapproved user cannot invoke it. Pause the assistant in OpenDots and verify that a permitted request receives a paused notice. Check Settings & setup for channel connection failures.

Local tests exercise channel behavior with fixtures. A live Slack mention/reply remains unverified until you provision the managed connection and model credentials. [Channels SDK documentation](https://github.com/CopilotKit/channels-sdk) describes extending the adapter and channel behavior.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model. `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Select an API model provider or leave service credentials empty for setup. Set `OWNER_TOKEN` to a random secret of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. Both runtime images include `.env.schema` and start through Varlock. Local `.env` files and credentials stay outside image layers. Compose supplies the configured environment. The browser service is optional. Set a different 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it. It has no published port. Application metadata lives in the `opendots-data` volume.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Automatic learning

OpenDots connects [CopilotKit Automatic Learning](https://docs.copilotkit.ai/learning)
to individual Dots. It uses the existing server-side `INTELLIGENCE_API_KEY` and
optional `INTELLIGENCE_API_URL`. No additional model key or frontend key is needed.

1. Open **Learning** in the same Intelligence project and create a container for
   one focused workflow, such as `research-workflow`. IDs use 1–64 lowercase
   letters, numbers, and single hyphens.
2. In OpenDots, edit the Dot and enter that ID under **Automatic Learning**.
   Saving the ID configures routing. It does not create or verify the remote container.
3. Start new conversations and complete related workflows. Each conversation keeps
   the container assigned when it was created. Existing conversations, including
   ones created before this integration, are not enrolled retroactively. Changing
   or clearing the Dot's ID affects only new conversations. This applies to page
   chat, scheduled and voice compute in those conversations, and new Slack threads.
4. In Intelligence, inspect the evidence, run Learning manually or use its schedule,
   and review and publish proposed skills. The default automatic threshold is 15
   eligible threads. Use the readiness count shown in your deployment.
5. Enable **Skill delivery** on the Intelligence container, then enable **Use
   published skills** in the Dot's settings. Start a new turn in an enrolled
   conversation. BuiltInAgent loads the latest verified published catalog. Its
   TanStack AI factory runs the model and exposes `copilotkit_load_skill` and `copilotkit_read_skill_file`.
   The model decides which relevant skills to load. Check the run's tool calls to
   verify actual use. Saving settings alone does not establish connectivity.

Skill delivery always uses the conversation's original container, even after the
Dot is pointed at another container. The Dot's delivery checkbox applies to all its
conversations. Unchecking it stops delivery on subsequent turns. Changing Learning
settings also stops active work. Conversations without a container do not request
skills. Existing research, memory, page, and computer permissions still apply.

Ingestion and delivery are separate. Clearing the container does not unenroll older
conversations. Pause Learning in Intelligence to stop its analysis. Turning off
delivery does not stop evidence collection. A delivery denial or an unavailable
initial skill snapshot fails the turn rather than silently continuing without the
configured skills. Restore delivery or uncheck **Use published skills** to continue
without them. Skills require review and publication in Intelligence. OpenDots does
not automatically approve them.

The integration uses an explicit container list, so ambient
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` and `CPK_INTELLIGENCE_SKILLS_REVISION`
variables do not override a conversation's configuration. Self-hosted Intelligence
must support the [skill delivery endpoints](https://docs.copilotkit.ai/intelligence/learned-skills).

## Development checks

```sh
npm run env:check
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:themes
```

Automated tests use service fixtures. Live model, Intelligence, Slack, and voice verification requires your own configured services.
