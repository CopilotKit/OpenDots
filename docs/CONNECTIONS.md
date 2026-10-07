# Connections

Connections give a Dot tools from remote [MCP](https://modelcontextprotocol.io) servers: email, calendars, issue trackers, notes, or your own services. Each connection belongs to one Dot.

## Add a connection

1. Open a Dot's settings (**Edit specialist**).
2. Under **Connections**, enter a name, the server's Streamable HTTP endpoint (for example `https://example.com/mcp`), and an optional bearer token.
3. Select **Connect**. OpenDots lists the server's tools and saves them.

Use **Refresh** after the server adds or changes tools. Your choices for existing tools are kept.

## Signing in (OAuth)

Many services ask you to sign in with your account instead of pasting a token. Add the server without a token. If it requires sign-in, the connection shows **needs sign-in**.

1. Select **Sign in**. A new tab opens the service's sign-in and consent page.
2. Approve access. The tab returns to OpenDots and says you're signed in.
3. The settings update on their own and list the service's tools.

OpenDots follows the MCP authorization spec through the official SDK: discovery, dynamic client registration, PKCE and refresh tokens. Access tokens refresh automatically. If the service stops accepting them, the connection asks you to sign in again, and its tools are hidden from the Dot until you do. **Sign out** forgets the tokens and stops the Dot's active turn.

Set `PUBLIC_URL` when OpenDots runs behind a proxy or on a hosted domain. The service sends you back to `PUBLIC_URL/oauth/mcp/callback`; without `PUBLIC_URL`, OpenDots uses the address your browser is on. A sign-in link works once and expires after 10 minutes.

## Approvals

Every tool starts enabled. A tool the server marks as read-only (`readOnlyHint`) runs on its own. Every other tool starts with **Ask first** on.

When a Dot calls an **Ask first** tool, the tool does not run. The server stores the exact connection, tool and arguments, and the Dot shows an approval card in chat with a summary and those stored arguments. The action runs only when you select **Approve & run**, through an owner-only server route. That route runs the stored request, never arguments sent with the approval, and only if the conversation's Dot still has that exact tool enabled. Requests expire after an hour. Each approval runs at most once. Reopening the conversation shows the saved result, or keeps checking while the action is still running. A saved result is only ever shown for the approval that produced it.

The read-only hint comes from the server, so it is only a hint. Turn on **Ask first** for any tool you do not fully trust, and turn off tools a Dot does not need.

Approval cards appear only in the web app. Through Slack or in scheduled runs, an **Ask first** tool tells the Dot to ask you to continue in the web app.

Changing a Dot's connections or tool settings stops that Dot's active turn.

## Security notes

- Tokens, OAuth tokens and OAuth client registrations are stored in the server's SQLite database and are never sent to the browser. Protect `DATABASE_PATH` the way you protect `.env`.
- Tool results are passed to the model as untrusted data.
- Endpoints must use `http` or `https` and cannot contain credentials in the URL. Local addresses are allowed, so you can run MCP servers on the same machine. Only add servers you trust.
