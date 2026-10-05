<div align="center">

# OpenDots

### Always-on AI coworkers that move between text, calls, and Slack.

**An open-source template for persistent AI agents, each with its own computer. Available on Web and Mobile.**

Built with [CopilotKit](https://github.com/CopilotKit/CopilotKit) and [AG-UI](https://docs.ag-ui.com/introduction). · [Get started](#get-started) · [Overview](#overview) · [Architecture](#architecture) · [Features](#features) · [Contributing](CONTRIBUTING.md)

[![CI](https://github.com/CopilotKit/OpenDots/actions/workflows/ci.yml/badge.svg)](https://github.com/CopilotKit/OpenDots/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)

<a href="https://trendshift.io/repositories/275323" target="_blank"><img src="https://trendshift.io/api/badge/trendshift/repositories/275323/daily?language=TypeScript" alt="CopilotKit/OpenDots | Trendshift #2 TypeScript Repository Of The Day" width="250" height="55"/></a>

Host OpenDots on your own infrastructure. Conversations require CopilotKit Intelligence: use the hosted service, the [local Docker evaluation](docs/SETUP.md#local-intelligence-evaluation), or a licensed [self-hosted deployment](https://docs.copilotkit.ai/intelligence/self-hosting). Clone this template and customize it however you want.

[**Building on OpenDots? Meet with the CopilotKit team →**](https://www.copilotkit.ai/talk-to-an-engineer?ref=opendots_readme)

</div>

---

<div align="center">

<table><tr><td>

https://github.com/user-attachments/assets/4c74fe7d-ecdd-42dd-95da-5d34f9b9576e

</td></tr></table>

</div>

_Ask → browse → approve → save. A live computer view and a human review card appear right in chat, then the approved draft becomes an editable Space page. Enlarged for readability; idle time is trimmed and playback is accelerated._

## Overview

OpenDots is a starting point for building your own agent workspace. Clone it, define your Dots, connect your services, and adapt the interface and tools to your needs.

**A template, not a hosted product.** You run the application and configure its infrastructure. The template is in early development; the Features section below describes what's included and distinguishes local verification from connected-service testing.

### Spaces

A Space is a home for working documents. Dots appear separately in navigation and can be granted access to multiple Spaces in their settings. Each Dot has a default destination for saved pages; existing installations retain their original Space access. Browse pages in a searchable library, switch between grid and list views, and organize documents as nested subpages. Open a page in a focused visual editor with formatting, slash commands, and undo/redo. Write directly, save a conversation as a page, or ask a specialist to create and revise content.

Pages stay in the local workspace database. Their conversations use CopilotKit Threads, with a separate conversation for each page and specialist. Page links connect the document workspace to Dot chat. Manual editing works before you configure conversation services. Autosave reports its progress, failed saves retain your draft, and revision checks prevent stale edits from overwriting newer content. Markdown source mode remains available.

<div align="center">

<table><tr><td>

https://github.com/user-attachments/assets/d20c3405-4339-49e7-a799-43298728015c

</td></tr></table>

</div>

_Open a Space, navigate to its launch brief, ask Scout about the saved page, and continue in Dot chat. This recording uses live page chat and example launch content._

### Specialist Dots

Give each Dot a name, role, instructions, and permitted tools. A researcher can investigate a topic; a writer can turn findings into a draft. Inspect their work and control what they can do.

### Dot computers

Each Dot can have its own computer, using [OpenBot](https://github.com/CopilotKit/OpenBot)'s container supervisor and computer service. Its browser profile and workspace files persist across stop/start. The Computer panel exposes browser control, human takeover, files, terminal output, and activity, with browser, file, and shell permissions set per Dot. The application keeps service credentials on the server and derives a different computer credential for each Dot.

See [Computer setup](docs/COMPUTERS.md) to build the pinned services and connect your deployment. Computer tools require those services; an unconfigured template does not execute commands on your host.

<div align="center">

<table><tr><td>

https://github.com/user-attachments/assets/30b691c3-0f66-4964-9fdb-67d4feab5568

</td></tr></table>

</div>

_Ask Scout to open a website, summarize it, save notes, and verify the file. Every computer action in this demo is requested through chat; CopilotKit tool renderers show the live browser, saved file, and terminal output inline._

### Review before saving

Ask a Dot to show a draft before saving it. A CopilotKit human-in-the-loop card pauses the conversation for **Approve & save** or **Decline**. Approval creates the page in an authorized Space and returns a link; retries with the same draft recover that saved page. A changed draft needs a new review. The agent continues after your decision.

### Text and calls

A continuous conversation keeps the Dot's avatar and status above the messages, with text and call controls close at hand. Work updates, source links, and call receipts appear in the timeline; a side panel shows results or the agent's computer.

Calls pair realtime speech with a separate compute agent, so the conversation can continue while longer work runs. Both use the same conversation context and tool permissions. The call screen includes a live timer, separate user and Dot captions, microphone mute, speaker mute, and a minimized view for continuing in chat. Voice needs separate provider configuration.

<div align="center">

<table><tr><td>

https://github.com/user-attachments/assets/3c06cf71-39ed-4e2b-b846-5463b2722389

</td></tr></table>

</div>

_Connect, talk, mute, minimize, and return to chat. This is a silent screen capture of a real call, with waiting time trimmed and playback accelerated._

### Slack

Mention a Dot through a managed Slack connection using Channels SDK, then continue in its thread. The integration follows [OpenTag](https://github.com/CopilotKit/OpenTag), with an explicit workspace/user allowlist and a selected specialist. See [Slack setup](docs/SETUP.md#slack) to connect your deployment.

<div align="center">

<table><tr><td>

https://github.com/user-attachments/assets/27d03a6c-a9e0-4c29-8d96-fafe0fbae20f

</td></tr></table>

</div>

Bring your agents into Slack with [Channels SDK](https://github.com/CopilotKit/channels-sdk). See the [managed Channels documentation](https://docs.copilotkit.ai/intelligence/channels) to connect them through CopilotKit Intelligence.

### iMessage

Text your Dot from your phone. When OpenDots runs on a Mac signed in to Messages, it answers allowlisted numbers and Apple ID emails. Each sender gets their own persistent conversation, and `/new` starts a fresh one. See [iMessage setup](docs/IMESSAGE.md).

## Architecture

### AG-UI connects the agent to the interface

[AG-UI](https://docs.ag-ui.com/introduction) carries streamed messages, tool calls, and agent state between the backend and CopilotKit components. Computer activity appears inline as the agent works; human-in-the-loop cards pause a tool call for your decision before it continues.

The template uses TanStack AI for model streaming and server-tool execution, CopilotKit's React SDK and runtime, Intelligence for durable Threads, and Channels SDK for Slack. Pages, application metadata, and background-work state are stored separately from conversation history.

```mermaid
flowchart TB
  Web["Web app: pages, Spaces, Dots, chat"] -->|AG-UI| Runtime[CopilotKit runtime]
  Slack[Slack] <--> Managed[Managed channel connection]
  Managed <--> Channels[Channels SDK]
  Channels --> Agents[Specialist compute agents]
  Runtime --> Agents
  Agents --> AI[TanStack AI]
  AI --> Provider[OpenAI-compatible model provider]
  Runtime <--> Intelligence["Intelligence / Threads"]
  Channels <--> Intelligence
  Web <--> Speech[Realtime speech]
  Speech --> Bridge[Compute bridge]
  Bridge --> Agents
  Agents --> Controls[Tool permissions]
  Controls --> Computer[Isolated browser / workspace]
  Agents --> Jobs[Background work]
  Runtime --> Metadata[(Pages, Spaces, Dots, work metadata)]
```

You configure the Intelligence project, model provider, and channel connection for your deployment; calls also need a speech provider. Credentials stay on the server. Missing configuration should produce a clear setup state, and test fixtures should remain visibly separate from live integrations.

[OpenMuse](https://github.com/CopilotKit/OpenMuse) and [OpenBot](https://github.com/CopilotKit/openbot) are code references for persistent work, agent computers, and execution controls. OpenDots can be adapted to your own workflows and deployment choices.

## Get started

Use **Node.js 24** and **npm**:

```sh
git clone https://github.com/CopilotKit/OpenDots.git
cd OpenDots
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. You can create Spaces, write pages, and configure Dots before connecting services. To start chatting, connect an Intelligence project and a model.

Choose where to store conversations before connecting. For local Docker evaluation, follow [Local Intelligence evaluation](docs/SETUP.md#local-intelligence-evaluation). For hosted Intelligence, sign in and select or create a project in the `OpenDots` folder:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

`project select` writes a project key to `.env` as `CPK_INTELLIGENCE_API_KEY`. Then add `OPENAI_API_KEY` and `OPENAI_MODEL` to `.env` and restart `npm run dev`.

Do not run `copilotkit onboard` in this folder. OpenDots already contains its CopilotKit integration, and onboarding adds a second, generic one.

See [Setup](docs/SETUP.md) for configuration, Slack, calls, the browser service, and Docker.

## Data and privacy

Conversation messages, tool calls, and run events are persisted in the configured Intelligence deployment. The hosted setup sends them to CopilotKit's cloud; the local evaluation setup uses Intelligence on your machine. OpenDots has no standalone SQLite conversation store. SQLite stores pages, workspace metadata, and thread bindings separately.

The configured model provider receives conversation context, including authorized page content and tool results. Local Intelligence does not make a remote model local: configure the app's model and the Automatic Learning model separately. Public-web research sends queries and selected URLs to Parallel by default; set `WEB_SEARCH_PROVIDER=disabled` to disable those tools. Speech and messaging integrations send data to their configured providers when used.

CopilotKit SDK telemetry collects usage metadata separately from conversation persistence. Set `COPILOTKIT_TELEMETRY_DISABLED=true` to opt out; see [CopilotKit telemetry](https://docs.copilotkit.ai/telemetry). Review [CopilotKit's privacy policy](https://www.copilotkit.ai/privacy-policy) and the policies and retention settings of each service you configure. Installing or renewing local Intelligence still requires CopilotKit sign-in and internet access.

## Features

| Area                       | Included                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Spaces and Specialist Dots | Saved names, role instructions, and per-Dot research and memory permissions                                                             |
| Pages                      | Searchable library, visual editor, slash commands, autosave, and revision checks                                                        |
| Conversations              | React SDK chat and Threads integration, page-specific conversations, and source links                                                   |
| Slack                      | Managed Channels SDK declaration with workspace and user allowlists                                                                     |
| iMessage                   | Local macOS bridge with a sender allowlist, per-sender conversations, and plain-text replies                                            |
| Calls                      | WebRTC speech, delegated compute, bounded sessions, hangup, and timeline receipts                                                       |
| Background work            | Scheduled server-side turns in their original conversation, with pause and retry controls                                               |
| Browser                    | Separate read-only public-page service with page capture and navigation limits                                                          |
| Dot computers              | Per-Dot browser profiles, files, shell, takeover, permissions, and action records through OpenBot                                       |
| Memory                     | User-managed preferences that permitted Dots can use                                                                                    |
| Automatic Learning         | Per-Dot Learning containers, conversation evidence routing, and published-skill delivery; see [setup](docs/SETUP.md#automatic-learning) |
| Deployment                 | Local Node setup and separate application/browser containers                                                                            |

Scheduled tasks run in their original conversation. If a worker stops or its lease expires during a run, OpenDots marks that run **Interrupted** and waits for an explicit retry. Review its pages and computer actions, then use **Retry after review** when appropriate. Completed effects may already be present even when a run has no final result.

Local checks cover setup, persistence, permissions, SDK failure handling, and browser isolation. Automated tests use service fixtures. **Live Intelligence, model responses, and page-context chat were verified on September 29, 2026.** Live OpenBot computer browsing, file creation, shell verification, and file persistence across stop/start were also verified locally. Live Realtime speech, call controls, and receipt persistence were verified locally on September 30, 2026. Slack and spoken compute delegation still need connected-service verification. See [recording notes](docs/demos/README.md) for the demonstrated flows and limits.

Automatic Learning routing and skill delivery are configured locally. Cloud schedules, eligible-thread counts, and published-skill delivery still need connected-service verification. Skills require review and publication in Intelligence; existing conversations without a container are not enrolled retroactively.

This is a single-owner starting point. Shared editing, invitations, file uploads, and interactive page embeds are not included. Schedules are recurring instructions, not a complete goal or event-trigger system. Specialist Dots have separate roles and conversations; multi-Dot group conversations and automatic delegation are further work.

### Extending the template

- Add identity, Space membership, and shared page editing for multi-user deployments.
- Add file attachments and richer page content.
- Add event triggers and a persistent responsibility lifecycle.
- Extend tools and approval flows for your own workflows.
- Add richer artifacts, connected-app context, and specialist coordination.

## Contributing

See [Contributing](CONTRIBUTING.md) for development guidance and [Security](SECURITY.md) for reporting issues. Contributions should describe the workflow they enable, include verification evidence, and distinguish live integrations from fixtures.

## References

- [AG-UI documentation](https://docs.ag-ui.com/introduction)
- [CopilotKit documentation](https://docs.copilotkit.ai/intelligence/overview)
- [Channels SDK](https://github.com/CopilotKit/channels-sdk)
- [OpenMuse](https://github.com/CopilotKit/OpenMuse)
- [OpenBot](https://github.com/CopilotKit/openbot)
- [OpenTag](https://github.com/CopilotKit/OpenTag) — Channels SDK integration reference

## License

[MIT](LICENSE).

## Public-web research

Parallel is selected by default in live research and Dot conversations. Ask a topic-only question to discover and read up to five sources, or supply URLs to extract them directly. Sources are saved with their links. A browser worker is not required for this research path; computer tools remain available for interactive work.

`WEB_SEARCH_PROVIDER=browser` preserves the existing URL-only browser reader, and `WEB_SEARCH_PROVIDER=disabled` disables these research tools. Workspace and Dot research permissions, pause and cancellation controls still apply. Sample research remains fictional and does not contact a provider.

Queries, requested URLs, a stable session identifier and the research objective are sent to `https://search.parallel.ai/mcp`. Memories and complete conversations are not automatically forwarded to Parallel. Model-selected objectives may still contain context from the conversation. The anonymous service is free for light use with provider-managed limits; set `PARALLEL_API_KEY` on the server for production or higher limits. Provider errors and empty results are reported rather than replaced with invented evidence. See [Parallel Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp).
