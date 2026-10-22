import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { SteeringInbox } from '../src/server/steering.js';
import type { Config } from '../src/server/research.js';
import type { Platform } from '../src/server/platform.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe('steering inbox', () => {
  it('keeps messages per conversation, oldest first, and drains them once', () => {
    const inbox = new SteeringInbox();
    expect(inbox.push('a', ' switch to SELL only ')).toBe(1);
    expect(inbox.push('a', 'lower the amount to $50')).toBe(2);
    expect(inbox.push('b', 'stop at $2,000')).toBe(1);
    expect(inbox.has('a')).toBe(true);
    expect(inbox.drain('a')).toEqual([
      'switch to SELL only',
      'lower the amount to $50',
    ]);
    expect(inbox.has('a')).toBe(false);
    expect(inbox.drain('a')).toEqual([]);
    expect(inbox.drain('b')).toEqual(['stop at $2,000']);
  });
  it('rejects empty, oversized and runaway messages', () => {
    const inbox = new SteeringInbox();
    expect(() => inbox.push('a', '   ')).toThrow();
    expect(() => inbox.push('a', 'x'.repeat(4001))).toThrow();
    for (let n = 0; n < 20; n++) inbox.push('a', `message ${n}`);
    expect(() => inbox.push('a', 'one too many')).toThrow(/waiting/);
  });
});

describe('steer route', () => {
  function fixture(mode: 'unattended' | 'confirm', token?: string) {
    const store = new Store(':memory:');
    stores.push(store);
    const config: Config = {
      mode: 'sample',
      baseUrl: 'https://api.openai.com/v1',
    };
    const policy = join(
      mkdtempSync(join(tmpdir(), 'steer-policy-')),
      'policy.json',
    );
    writeFileSync(policy, JSON.stringify({ mode }));
    const steering = new SteeringInbox();
    // Only what the steer route and route registration touch.
    const platform = {
      computers: {},
      browser: {},
      teamBoard: { store: { list: () => [] } },
      config: {
        mcp: {
          localConfirmationConfig: () => ({
            path: policy,
            defaultConfirm: true,
          }),
        },
      },
      runner: {
        isRunning: async ({ threadId }: { threadId: string }) =>
          threadId === 'busy',
      },
      steering,
    } as unknown as Platform;
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      ownerToken: token,
      platform,
    });
    return { app, steering };
  }
  const post = (body: unknown, token?: string) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  it('says sending to a running task is unavailable, and queues nothing', async () => {
    // The current run loop does not read mid-run messages, so the route must
    // not accept one that would never reach the task.
    const { app, steering } = fixture('unattended');
    const response = await app.request(
      '/api/threads/busy/steer',
      post({ text: 'only SELL from now on' }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(
      /not available in this version.*Press Stop/,
    );
    expect(steering.has('busy')).toBe(false);
  });
  it('requires the owner token like every other API route', async () => {
    const { app } = fixture('unattended', 'secret-token');
    expect(
      (await app.request('/api/threads/busy/steer', post({ text: 'hi' })))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/threads/busy/steer',
          post({ text: 'hi' }, 'secret-token'),
        )
      ).status,
    ).toBe(409);
  });
});
