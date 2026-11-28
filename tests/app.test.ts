import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import { resolveAppOrigins } from '../src/server/app-origin.js';
const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(token?: string, origin?: string | string[]) {
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
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'allows a same-origin Vite proxy mutation from %s',
    async (origin) => {
      const { app } = fixture(
        undefined,
        resolveAppOrigins(undefined, 'development'),
      );
      const response = await app.request(`${origin}/api/tasks`, {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(response.status).toBe(201);
    },
  );
  it.each([
    'https://evil.example',
    'http://localhost:5174',
    'https://localhost:5173',
  ])(
    'rejects an unlisted origin %s with multiple origins configured',
    async (origin) => {
      const { app } = fixture(
        undefined,
        resolveAppOrigins(undefined, 'development'),
      );
      const response = await app.request('http://localhost:5173/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Cross-origin requests are not allowed.',
      });
    },
  );
  it('rejects cross-site requests even from a configured origin', async () => {
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'development'),
    );
    const response = await app.request('http://127.0.0.1:4310/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Cross-site requests are not allowed.',
    });
  });
  it('preserves exact matching for a single configured origin', async () => {
    const { app } = fixture(undefined, 'http://localhost:5173');
    for (const [origin, status] of [
      ['http://localhost:5173', 201],
      ['http://127.0.0.1:5173', 403],
    ] as const) {
      const response = await app.request('http://localhost:5173/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(response.status).toBe(status);
    }
  });
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    'requires owner authentication for an allowed origin %s',
    async (origin) => {
      const { app } = fixture(
        'private-token',
        resolveAppOrigins(undefined, 'development'),
      );
      for (const [authorization, status] of [
        [undefined, 401],
        ['Bearer wrong-token', 401],
        ['Bearer private-token', 201],
      ] as const) {
        const response = await app.request(`${origin}/api/tasks`, {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Sec-Fetch-Site': 'same-origin',
            ...(authorization ? { Authorization: authorization } : {}),
          },
        });
        expect(response.status).toBe(status);
      }
    },
  );
  it('rejects unrecognized hosts even when the origin is explicitly allowed', async () => {
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'development'),
    );
    const response = await app.request('http://attacker.example/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Unrecognized host.' });
  });
  it('does not widen access when an explicit origin list contains only blank entries', async () => {
    const { app } = fixture(undefined, resolveAppOrigins(' , ', 'development'));
    const response = await app.request('http://localhost:5173/api/tasks', {
      ...json({ prompt: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(response.status).toBe(403);
  });
  it('requires the request URL origin by default in production', async () => {
    const { app } = fixture(
      undefined,
      resolveAppOrigins(undefined, 'production'),
    );
    for (const [origin, status] of [
      ['http://localhost:4310', 201],
      ['http://localhost:5173', 403],
    ] as const) {
      const response = await app.request('http://localhost:4310/api/tasks', {
        ...json({ prompt: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(response.status).toBe(status);
    }
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
  it('validates, updates, dismisses, and deletes durable goals', async () => {
    const { app, store } = fixture();
    const reminderAt = Date.now() + 60_000;
    const created = await app.request(
      '/api/goals',
      json({
        title: 'Prepare a launch brief',
        description: 'Collect final notes',
        reminderAt,
      }),
    );
    expect(created.status).toBe(201);
    const goal = (await created.json()) as { id: string };
    expect(store.goal(goal.id)?.status).toBe('active');
    const state = (await (await app.request('/api/state')).json()) as {
      goals: { id: string }[];
    };
    expect(state.goals[0]?.id).toBe(goal.id);
    expect(
      (
        await app.request(
          '/api/goals',
          json({
            title: 'Invalid progress',
            progress: 101,
            reminderAt: Date.now() + 60_000,
          }),
        )
      ).status,
    ).toBe(400);
    const update = await app.request(`/api/goals/${goal.id}`, {
      ...json({
        title: 'Prepare a launch brief',
        description: 'Collect final notes',
        status: 'paused',
        progress: 45,
        reminderAt,
      }),
      method: 'PUT',
    });
    expect(update.status).toBe(200);
    expect(store.goal(goal.id)?.progress).toBe(45);
    await app.request(`/api/goals/${goal.id}/reminder/dismiss`, json({}));
    expect(store.goal(goal.id)?.reminderDismissedAt).not.toBeNull();
    const deleted = await app.request(`/api/goals/${goal.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(deleted.status).toBe(200);
    expect(store.goal(goal.id)).toBeUndefined();
    expect((await app.request('/api/state')).status).toBe(200);
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
