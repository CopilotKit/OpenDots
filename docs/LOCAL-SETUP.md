# Running OpenDots locally, on a LAN, and over Tailscale

This covers a self-hosted setup: OpenDots talks to a **local CopilotKit
Intelligence** stack (Docker/k3d) and to an **OpenAI-compatible model**, and is
reachable from other machines on the LAN / tailnet.

It documents the customizations in this branch and the infrastructure steps that
live outside the repository, so the setup can be reproduced from scratch.

## What this branch changes

| Change                                                            | Why                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`: `server.host: '0.0.0.0'` + `allowedHosts: true` | Let the dev server be reached over the LAN/tailnet instead of loopback only. The API stays on `127.0.0.1:4310`; Vite proxies `/api`.                                                                                                                                                         |
| `src/client/polyfills.ts` (+ one `import` in `main.tsx`)          | `crypto.randomUUID()` only exists in a **secure context** (HTTPS or `localhost`). On plain-HTTP access via an IP the CopilotKit client throws and the Dot hangs forever on "Dot is thinking". The shim derives a v4 UUID from `crypto.getRandomValues` (available without a secure context). |

No secrets are committed: `.env`, `data/`, and `.copilotkit/` are git-ignored.

## 1. Prerequisites

- Node.js 24 and npm
- Docker (for the local Intelligence stack)
- The CopilotKit CLI: `npx copilotkit@latest`
- Optional: Tailscale, for HTTPS / remote access

## 2. Install

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`. Fill in the provider fields — a commented template
is in `deployment/local/env.local.example`.

## 3. Local Intelligence (self-hosted via Docker/k3d)

Needs a CopilotKit account (the free Developer plan qualifies). Run from the app
folder:

```sh
npx copilotkit@latest login
npx copilotkit@latest local setup
npx copilotkit@latest local connect                  # preview
npx copilotkit@latest local connect --approve-connection
```

`local connect` writes these to `.env`:

```
INTELLIGENCE_API_URL=http://localhost:<api-port>
INTELLIGENCE_GATEWAY_WS_URL=ws://localhost:<gateway-port>
CPK_INTELLIGENCE_API_KEY=cpk-...
SL_ENABLED=true
```

Notes:

- The stack is tied to the **app folder** it was created in. `local status` /
  `local connect` only recognise it from that path. If you cloned elsewhere, run
  `npx copilotkit@latest local connect --stack <id>` (see `local list`).
- The stack's services are published on `127.0.0.1` only.
- After `local setup`, any previous Intelligence project is replaced, so old
  conversation bindings become stale (see §9).

## 4. Model provider (OpenAI-compatible)

Set in `.env`:

```
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1   # or any compatible endpoint
OPENAI_MODEL=...
```

`OPENAI_BASE_URL` only affects the compute model — not realtime voice.

## 5. LAN / Tailscale access

- Vite listens on `0.0.0.0:5173` (this branch) and proxies `/api` to `4310`.
- Set `APP_ORIGIN` to the exact browser origins you use. Its hostnames are also
  whitelisted for the API, so include every host you access from:

```
APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173,http://<LAN-IP>:5173,http://<TAILSCALE-IP>:5173
```

### The realtime gateway must be reachable by the browser

The runtime advertises `INTELLIGENCE_GATEWAY_WS_URL` to the browser, which opens
a socket at `<that URL>/client/websocket?join_token=...`. If the browser cannot
reach it, the Dot stays "thinking" even though the server processed the turn.

Because the k3d stack maps the gateway to `127.0.0.1:<port>` only, forward that
port on the address the browser uses. Ready-made units are in
`deployment/local/` (socat + systemd), e.g.:

```sh
sudo cp deployment/local/opendots-gateway-lan.service /etc/systemd/system/
sudo systemctl enable --now opendots-gateway-lan.service
```

Then point `.env` at the host the browser uses:

```
INTELLIGENCE_GATEWAY_WS_URL=ws://<host-the-browser-uses>:40231
```

One URL is advertised to all clients, so pick the host you actually access with
(LAN IP _or_ tailnet IP). For a setup that must work from both, expose the
gateway on a name that resolves on both, and use that name here.

After changing `.env`, restart `npm run dev`.

## 6. "Dot is thinking" forever

Almost always one of:

- the realtime gateway is unreachable from the browser (§5), or
- `crypto.randomUUID is not a function` in the browser console — plain-HTTP
  access via an IP is not a secure context. Fixed by
  `src/client/polyfills.ts` in this branch. The alternative is to serve the app
  over HTTPS.

Quick check with a headless browser: open the LAN URL, click **New chat**, send a
message, and confirm the reply appears and there are no `pageerror`s.

## 7. Slack (managed channel on a local stack)

The CLI `copilotkit channels add` only works for a **hosted** project. On a local
stack, create the channel in the local dashboard
(`npx copilotkit@latest local login` → `http://localhost:<frontend-port>`).

Slack must reach the stack over a **public HTTPS address**. Example with
Tailscale Funnel:

```sh
# enable HTTPS certificates + Funnel for the node in the Tailscale admin console, then:
sudo tailscale funnel --bg <frontend-port>   # e.g. the stack dashboard
```

In the Slack app (Event Subscriptions → Request URL):

```
https://<public-host>/api/channels/adapters/slack/events
```

That endpoint accepts **POST** with JSON (Slack's Events API) and echoes the
verification `challenge`. Opening the URL in a browser sends GET and returns an
error (`ROUTE_NOT_FOUND`) — that is expected; put it in Slack, not the browser.

Then in `.env`:

```
SLACK_CHANNEL_NAME=<managed channel name, NOT a #channel name>
SLACK_TEAM_ID=T...
SLACK_USER_IDS=U...
```

`SLACK_CHANNEL_NAME` must match the **managed channel** name declared in the
dashboard, not a Slack conversation like `#general`.

## 8. Voice (calls)

Uses the OpenAI Realtime API at `api.openai.com/v1/realtime/calls` (fixed in the
adapter), so it needs an OpenAI key with Realtime access:

```
VOICE_API_KEY=...
VOICE_MODEL=gpt-realtime-...     # a supported Realtime model
VOICE_NAME=marin
```

## 9. Maintenance

- Back up `.env` before changing providers. The `copilotkit local` CLI also
  writes backups.
- **Stale conversations** after re-running `local setup`: `thread_bindings` in
  `data/opendots.sqlite` may point to threads that no longer exist in the new
  Intelligence project, so a run fails with `THREAD_NOT_FOUND`. Remove the orphan
  rows (compare with `GET <INTELLIGENCE_API_URL>/api/threads?userId=<OWNER_ID>`).

## 10. Troubleshooting

- `403 /api/copilotkit/inspector-metadata` in the console — benign; OpenDots
  disables the inspector routes.
- `415 Use application/json` — the API requires `Content-Type: application/json`
  on POST/DELETE.
- `403 Unrecognized host` / `Cross-origin requests are not allowed` — the
  browser origin/host is missing from `APP_ORIGIN`.
- Local Intelligence ports are ephemeral; re-read them from `.env` or
  `copilotkit local status`.
