import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBridge } from './bridge';
import { LoginServiceError } from './login-service';

const TOKEN = 'test-token';

let dir: string;
let socketPath: string;
let close: () => Promise<void>;
const calls: unknown[][] = [];

beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), 'ploop-bridge-'));
  socketPath = path.join(dir, 'b.sock');
  ({ close } = await startBridge({
    socketPath,
    token: TOKEN,
    service: {
      listForAgent: async () => [
        { label: 'GitHub', site: 'github.com', username: 'ephraim' },
      ],
      signInForAgent: async (site, username) => {
        calls.push(['sign-in', site, username]);
        if (site === 'nowhere.example')
          throw new LoginServiceError('No such login.', 404);
        return {
          status: 'signed-in',
          url: 'https://github.com/',
          title: 'GitHub',
          note: 'Signed in.',
        };
      },
      readPageForAgent: async (site, username, url) => {
        calls.push(['read-page', site, username, url]);
        return { url, title: 'Page', text: 'text' };
      },
    },
  }));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

function request(options: {
  method?: string;
  path: string;
  token?: string | null;
  body?: unknown;
}) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (options.token !== null)
      headers.authorization = `Bearer ${options.token ?? TOKEN}`;
    const req = http.request(
      {
        socketPath,
        path: options.path,
        method: options.method ?? 'GET',
        headers,
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
        );
      },
    );
    req.on('error', reject);
    req.end(
      options.body === undefined ? undefined : JSON.stringify(options.body),
    );
  });
}

describe('bridge', () => {
  it('lives in a socket only its owner can use', async () => {
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses callers without the token', async () => {
    for (const token of [null, 'wrong', `${TOKEN}x`, '']) {
      const result = await request({ path: '/v1/logins', token });
      expect(result.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('lists logins for the agent', async () => {
    const result = await request({ path: '/v1/logins' });
    expect(result).toEqual({
      status: 200,
      body: {
        logins: [{ label: 'GitHub', site: 'github.com', username: 'ephraim' }],
      },
    });
  });

  it('signs in and reads pages through the service', async () => {
    const signIn = await request({
      method: 'POST',
      path: '/v1/sign-in',
      body: { site: 'github.com', username: 'ephraim' },
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body).toMatchObject({ status: 'signed-in' });

    const read = await request({
      method: 'POST',
      path: '/v1/read-page',
      body: {
        site: 'github.com',
        username: 'ephraim',
        url: 'https://github.com/x',
      },
    });
    expect(read.body).toMatchObject({ title: 'Page' });
    expect(calls).toEqual([
      ['sign-in', 'github.com', 'ephraim'],
      ['read-page', 'github.com', 'ephraim', 'https://github.com/x'],
    ]);
  });

  it('passes service errors through with their status', async () => {
    const result = await request({
      method: 'POST',
      path: '/v1/sign-in',
      body: { site: 'nowhere.example', username: 'x' },
    });
    expect(result).toEqual({ status: 404, body: { error: 'No such login.' } });
  });

  it('rejects malformed or oversized requests and unknown routes', async () => {
    expect(
      (
        await request({
          method: 'POST',
          path: '/v1/sign-in',
          body: { site: 'github.com' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          method: 'POST',
          path: '/v1/sign-in',
          body: { site: 'x'.repeat(40_000), username: 'a' },
        })
      ).status,
    ).toBe(400);
    expect((await request({ path: '/v1/passwords' })).status).toBe(404);
  });
});
