import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  desktopBridgeFromEnv,
  vaultTools,
  type DesktopBridge,
} from '../src/server/desktop-bridge.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

// A stand-in for the Mac app's end of the socket.
async function fakeVault(
  answer: (request: { method?: string; url?: string; body: string }) => {
    status: number;
    body: unknown;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const bridge: DesktopBridge = {
    socketPath: join(dir, 'bridge.sock'),
    token: 'secret-token',
  };
  const seen: { auth?: string; method?: string; url?: string; body: string }[] =
    [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({
        auth: request.headers.authorization,
        method: request.method,
        url: request.url,
        body,
      });
      const reply = answer({ method: request.method, url: request.url, body });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(bridge.socketPath, resolve),
  );
  cleanup.push(
    () => server.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return { bridge, seen };
}

function tool(bridge: DesktopBridge, name: string) {
  const found = vaultTools(bridge, () => {}, new AbortController().signal).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`No ${name} tool.`);
  return found as unknown as { execute(input: unknown): Promise<unknown> };
}

it('reads the bridge only when both the socket and token are set', () => {
  expect(desktopBridgeFromEnv({})).toBeUndefined();
  expect(
    desktopBridgeFromEnv({ PLOOP_BRIDGE_SOCKET: '/tmp/s.sock' }),
  ).toBeUndefined();
  expect(
    desktopBridgeFromEnv({
      PLOOP_BRIDGE_SOCKET: '/tmp/s.sock',
      PLOOP_BRIDGE_TOKEN: 't',
    }),
  ).toEqual({ socketPath: '/tmp/s.sock', token: 't' });
});

it('lists logins and signs in through the socket with the token', async () => {
  const { bridge, seen } = await fakeVault(({ url }) =>
    url === '/v1/logins'
      ? {
          status: 200,
          body: {
            logins: [
              { label: 'GitHub', site: 'github.com', username: 'ephraim' },
            ],
          },
        }
      : {
          status: 200,
          body: {
            status: 'signed-in',
            url: 'https://github.com/',
            title: 'GitHub',
            note: 'Signed in.',
          },
        },
  );
  await expect(tool(bridge, 'list_logins').execute({})).resolves.toEqual({
    logins: [{ label: 'GitHub', site: 'github.com', username: 'ephraim' }],
  });
  await expect(
    tool(bridge, 'sign_in_to_site').execute({
      site: 'github.com',
      username: 'ephraim',
    }),
  ).resolves.toMatchObject({ status: 'signed-in' });
  expect(seen.map((request) => request.auth)).toEqual([
    'Bearer secret-token',
    'Bearer secret-token',
  ]);
  expect(seen[1]).toMatchObject({
    method: 'POST',
    url: '/v1/sign-in',
    body: JSON.stringify({ site: 'github.com', username: 'ephraim' }),
  });
});

it('passes on the vault’s own reason when it refuses', async () => {
  const { bridge } = await fakeVault(() => ({
    status: 403,
    body: { error: 'The owner didn’t allow signing in to github.com.' },
  }));
  await expect(
    tool(bridge, 'sign_in_to_site').execute({
      site: 'github.com',
      username: 'ephraim',
    }),
  ).rejects.toThrow('The owner didn’t allow signing in to github.com.');
});

it('rejects an answer that isn’t what the vault should send', async () => {
  const { bridge } = await fakeVault(() => ({
    status: 200,
    body: { logins: [{ password: 'hunter2' }] },
  }));
  await expect(tool(bridge, 'list_logins').execute({})).rejects.toThrow(
    'The vault sent an unexpected answer.',
  );
});
