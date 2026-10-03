import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { research, type Config } from '../src/server/research.js';
const config: Config = {
  mode: 'live',
  apiKey: 'test',
  model: 'test',
  browserUrl: 'http://browser:4311',
  browserSecret: 'test',
  baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
it('aborts research when permissions are revoked outside the runner instance', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  let requestSignal: AbortSignal | undefined;
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', request);
  store.createTask('Read https://example.com');
  const tick = runner.tick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(store.tasks()[0].status).toBe('interrupted');
  runner.stop();
  store.close();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      title: 'Source',
      text: 'Page text',
      url: 'https://example.com',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(
    research(
      'Read https://example.com',
      [],
      config,
      controller.signal,
      (text) => {
        if (text.startsWith('Source captured')) controller.abort();
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
  const store = new Store(':memory:');
  store.saveMemory('Sensitive preference');
  store.updateSettings({ memoryAllowed: false });
  const task = store.createTask('Read this sample');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  await runner.tick();
  expect(store.detail(task.id)?.runs[0].result?.text).not.toContain(
    'Sensitive preference',
  );
  store.close();
});
it('holds active work for review on graceful shutdown', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  store.createTask('Read https://example.com');
  const pending = runner.tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  runner.stop();
  await pending;
  expect(store.tasks()[0].status).toBe('interrupted');
  expect(store.claim()).toBeNull();
  store.action(store.tasks()[0].id, 'run');
  expect(store.claim()).toBeTruthy();
  store.close();
});
