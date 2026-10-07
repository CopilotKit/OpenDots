import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ConnectionService } from '../src/server/connections.js';
import {
  connectionRoutes,
  oauthCallbackRoute,
} from '../src/server/connection-routes.js';
import { OAUTH_CALLBACK_PATH } from '../src/server/connection-oauth.js';
import type { Connection } from '../src/shared/connection-types.js';
import { oauthMcpServer } from './fixtures/oauth-mcp-server.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});
const origin = 'http://127.0.0.1:5173';
async function fixture() {
  const server = await oauthMcpServer();
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(server.close, () => workspace.close());
  const connections = new ConnectionService(workspace.connections);
  const app = new Hono();
  app.route('/api', connectionRoutes(workspace, connections));
  app.route(OAUTH_CALLBACK_PATH, oauthCallbackRoute(connections));
  const api = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await app.request(`${origin}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as T };
  };
  const dotId = workspace.dots()[0].id;
  // Follows the provider's consent redirect the way the owner's browser would.
  const consent = async (authorizationUrl: string) => {
    const response = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(
      `${origin}${OAUTH_CALLBACK_PATH}`,
    );
    return callback.pathname + callback.search;
  };
  return { server, workspace, connections, app, api, dotId, consent };
}
it('signs in to an OAuth-protected MCP server and uses its tools', async () => {
  const f = await fixture();
  const added = await f.api<Connection>(
    `/dots/${f.dotId}/connections`,
    'POST',
    { name: 'Calendar', url: f.server.url },
  );
  expect(added.status).toBe(201);
  expect(added.data).toMatchObject({
    authMode: 'oauth',
    signedIn: false,
    tools: [],
  });
  expect(f.connections.tools(f.dotId)).toEqual([]);
  const start = await f.api<{ authorizationUrl: string }>(
    `/connections/${added.data.id}/sign-in`,
    'POST',
    {},
  );
  const authorization = new URL(start.data.authorizationUrl);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization.searchParams.get('redirect_uri')).toBe(
    `${origin}${OAUTH_CALLBACK_PATH}`,
  );
  const callback = await f.consent(start.data.authorizationUrl);
  const done = await f.app.request(callback);
  expect(done.status).toBe(200);
  expect(await done.text()).toContain('Signed in to Calendar');
  const [connection] = (
    await f.api<Connection[]>(`/dots/${f.dotId}/connections`)
  ).data;
  expect(connection).toMatchObject({ signedIn: true, error: null });
  expect(connection.tools.map((tool) => tool.name)).toEqual(['list_events']);
  // Tokens and client registration stay server-side.
  const tokens = f.workspace.connections.oauth(connection.id).tokens as {
    access_token: string;
    refresh_token: string;
  };
  expect(JSON.stringify(connection)).not.toContain(tokens.access_token);
  expect(JSON.stringify(connection)).not.toContain(tokens.refresh_token);
  const [exposed] = f.connections.tools(f.dotId);
  expect(exposed.name).toBe('calendar__list_events');
  expect(await f.connections.call(exposed, { day: 'Monday' })).toEqual({
    isError: false,
    text: 'Standup on Monday',
  });
  // An expired access token is refreshed without the owner.
  f.server.provider.expireAccessTokens();
  expect(await f.connections.call(exposed, { day: 'Tuesday' })).toEqual({
    isError: false,
    text: 'Standup on Tuesday',
  });
  expect(f.server.provider.refreshes).toBe(1);
  expect(f.server.calls).toEqual(['Monday', 'Tuesday']);
});
it('rejects replayed, forged, and denied callbacks', async () => {
  const f = await fixture();
  const added = await f.api<Connection>(
    `/dots/${f.dotId}/connections`,
    'POST',
    { name: 'Calendar', url: f.server.url },
  );
  const start = await f.api<{ authorizationUrl: string }>(
    `/connections/${added.data.id}/sign-in`,
    'POST',
    {},
  );
  const callback = await f.consent(start.data.authorizationUrl);
  expect((await f.app.request(callback)).status).toBe(200);
  const replay = await f.app.request(callback);
  expect(replay.status).toBe(400);
  expect(await replay.text()).toContain('expired');
  const forged = await f.app.request(
    `${OAUTH_CALLBACK_PATH}?code=x&state=not-a-state`,
  );
  expect(forged.status).toBe(400);
  const denied = await f.app.request(
    `${OAUTH_CALLBACK_PATH}?error=access_denied&state=x`,
  );
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain('Access was denied');
  const injected = await f.app.request(
    `${OAUTH_CALLBACK_PATH}?code=x&state=${encodeURIComponent('<script>')}`,
  );
  expect(await injected.text()).not.toContain('<script>');
});
it('signs out, hides the tools, and asks to sign in again', async () => {
  const f = await fixture();
  const added = await f.api<Connection>(
    `/dots/${f.dotId}/connections`,
    'POST',
    { name: 'Calendar', url: f.server.url },
  );
  const start = await f.api<{ authorizationUrl: string }>(
    `/connections/${added.data.id}/sign-in`,
    'POST',
    {},
  );
  await f.app.request(await f.consent(start.data.authorizationUrl));
  const [exposed] = f.connections.tools(f.dotId);
  const before = f.workspace.connections.fingerprint(f.dotId);
  const out = await f.api<Connection>(
    `/connections/${added.data.id}/sign-out`,
    'POST',
    {},
  );
  expect(out.data.signedIn).toBe(false);
  // Signing out stops the Dot's active turn, like other access changes.
  expect(f.workspace.connections.fingerprint(f.dotId)).not.toBe(before);
  expect(f.connections.tools(f.dotId)).toEqual([]);
  expect(await f.connections.call(exposed, { day: 'Monday' })).toEqual({
    isError: true,
    text: 'Sign in to this service again.',
  });
  // Sign-in is refused for token connections.
  const tokenConnection = f.workspace.connections.create(
    f.dotId,
    { name: 'Plain', url: 'https://plain.example/mcp' },
    [],
  );
  const refused = await f.api<{ error: string }>(
    `/connections/${tokenConnection.id}/sign-in`,
    'POST',
    {},
  );
  expect(refused.data.error).toContain('does not use sign-in');
});
it('validates PUBLIC_URL for sign-in callbacks', async () => {
  const { publicUrlFromEnv } = await import('../src/server/platform-config.js');
  expect(publicUrlFromEnv(undefined)).toBeUndefined();
  expect(publicUrlFromEnv('  ')).toBeUndefined();
  expect(publicUrlFromEnv('https://dots.example.com/')).toBe(
    'https://dots.example.com',
  );
  expect(() => publicUrlFromEnv('ftp://dots.example.com')).toThrow(
    'PUBLIC_URL',
  );
  expect(() => publicUrlFromEnv('https://user:pw@dots.example.com')).toThrow(
    'PUBLIC_URL',
  );
  expect(() => publicUrlFromEnv('not a url')).toThrow();
});
