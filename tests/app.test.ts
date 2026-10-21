import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(token?: string, origin?: string) {
  const store = new Store(':memory:');
  stores.push(store);
  const runner = new Runner(store, config);
  return {
    store,
    runner,
    app: createApp({ store, runner, config, ownerToken: token, origin }),
  };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe('API boundaries', () => {
  it('accepts each listed origin, such as the desktop and a Tailscale address', async () => {
    const { app } = fixture(
      undefined,
      'http://127.0.0.1:5173,https://pc.tailnet.ts.net:8443',
    );
    const from = (url: string, origin: string) =>
      app.request(url, { headers: { Origin: origin } });
    expect(
      (await from('http://127.0.0.1:5173/api/state', 'http://127.0.0.1:5173'))
        .status,
    ).toBe(200);
    expect(
      (
        await from(
          'https://pc.tailnet.ts.net:8443/api/state',
          'https://pc.tailnet.ts.net:8443',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await from(
          'https://pc.tailnet.ts.net:8443/api/state',
          'https://evil.example',
        )
      ).status,
    ).toBe(403);
    expect(
      (await from('http://other.host/api/state', 'http://other.host')).status,
    ).toBe(403);
  });
  it('lets a long chat through but keeps other requests small', async () => {
    const { app } = fixture();
    const big = JSON.stringify({ messages: ['x'.repeat(2_000_000)] });
    const post = (path: string) =>
      app.request(`http://127.0.0.1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(big.length),
        },
        body: big,
      });
    // A night of trading made the conversation about 1.1 MB.
    expect((await post('/api/copilotkit')).status).not.toBe(413);
    expect((await post('/api/memories')).status).toBe(413);
  });
  it('accepts same-port loopback aliases but rejects unrelated origins', async () => {
    const { app } = fixture(undefined, 'http://127.0.0.1:5173');
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://[::1]:5173',
    ]) {
      expect(
        (await app.request('/api/state', { headers: { Origin: origin } }))
          .status,
      ).toBe(200);
    }
    for (const origin of [
      'http://localhost:5174',
      'https://localhost:5173',
      'http://localhost.evil.example:5173',
      'https://evil.example',
      'null',
      'http://localhost:5173/path',
    ]) {
      expect(
        (await app.request('/api/state', { headers: { Origin: origin } }))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await app.request('/api/state', {
          headers: {
            Origin: 'http://localhost:5173',
            'Sec-Fetch-Site': 'cross-site',
          },
        })
      ).status,
    ).toBe(403);
    const remote = fixture(undefined, 'https://dots.example');
    expect(
      (
        await remote.app.request('/api/state', {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(403);
  });
  it('requires owner token for state and mutations when configured', async () => {
    const { app } = fixture('private-token');
    expect((await app.request('/api/state')).status).toBe(401);
    expect(
      (
        await app.request('/api/state', {
          headers: { Authorization: 'Bearer private-token' },
        })
      ).status,
    ).toBe(200);
  });
  it('blocks browser cross-origin requests and form posts', async () => {
    const { app } = fixture();
    expect(
      (
        await app.request('/api/tasks', {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/tasks', {
          method: 'POST',
          body: 'prompt=hello',
        })
      ).status,
    ).toBe(415);
  });
  it('validates inputs and enforces research permissions on the server', async () => {
    const { app, store } = fixture();
    expect(
      (await app.request('/api/tasks', json({ prompt: 'x' }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/tasks',
          json({ prompt: 'Research', intervalSeconds: 1 }),
        )
      ).status,
    ).toBe(400);
    store.updateSettings({ researchAllowed: false });
    expect(
      (await app.request('/api/tasks', json({ prompt: 'Research' }))).status,
    ).toBe(403);
    expect(store.claim()).toBeNull();
  });
  it('runs a sample job from the durable queue and retains its result', async () => {
    const { app, store, runner } = fixture();
    const response = await app.request(
      '/api/tasks',
      json({ prompt: 'Plan a quiet weekend' }),
    );
    expect(response.status).toBe(201);
    await runner.tick();
    const task = store.tasks()[0];
    expect(task.status).toBe('completed');
    expect(store.detail(task.id)?.runs[0].result?.sample).toBe(true);
  });
  it('persists memory edits and deletes', async () => {
    const { app, store } = fixture();
    await app.request('/api/memories', json({ text: 'Prefer short briefs' }));
    const memory = store.memories()[0];
    const updated = await app.request(`/api/memories/${memory.id}`, {
      ...json({ text: 'Prefer deep briefs' }),
      method: 'PUT',
    });
    expect(updated.status).toBe(200);
    expect(store.memories()[0].text).toBe('Prefer deep briefs');
    await app.request(`/api/memories/${memory.id}`, {
      ...json({}),
      method: 'DELETE',
    });
    expect(store.memories()).toHaveLength(0);
  });
});
it('rejects DNS-rebinding Host even with a matching hostile Origin', async () => {
  const { app } = fixture();
  const response = await app.request('http://attacker.example/api/tasks', {
    ...json({ prompt: 'Sneaky task' }),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://attacker.example',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  expect(response.status).toBe(403);
});
