import { expect, it } from 'vitest';
import { validateRuntimeScope } from '../src/server/runtime-scope.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
} from '../src/server/platform-config.js';
it('blocks unbound cross-Dot run and inspector routes before contacting Intelligence', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const dot = store.dots()[0];
  store.bindThread('thread-a', dot.id, 'A');
  expect(() =>
    validateRuntimeScope(
      new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
      }),
      store,
      { threadId: 'other-owner' },
    ),
  ).toThrow();
  expect(() =>
    validateRuntimeScope(
      new Request('http://localhost/api/copilotkit/inspect/threads/foreign'),
      store,
      null,
    ),
  ).toThrow();
  expect(() =>
    validateRuntimeScope(
      new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
      }),
      store,
      { threadId: 'thread-a' },
    ),
  ).not.toThrow();
  store.close();
});
it('reports setup honestly without a standalone agent fallback', () => {
  const status = setupStatus({
    baseUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  expect(status.intelligence).toBe(false);
  expect(status.voice).toBe(false);
  expect(status.slack).toBe('not_configured');
  expect(status.missing).toContain(INTELLIGENCE_KEY_MISSING_LABEL);
});
it('rejects stop scope bypasses and misleading prefixes while allowing canonical owned routes', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const dot = store.dots()[0];
  store.bindThread('bound', dot.id, 'Bound');
  for (const path of [
    `/agent/${dot.id}/stop/foreign`,
    '/threads/bound/threads/foreign/messages',
    `/agent/${dot.id}/agent/foreign/run`,
    '/prefix/info',
    '/threads//bound/messages',
    '/threads/bound%2Fthreads%2Fforeign/messages',
  ]) {
    expect(() =>
      validateRuntimeScope(
        new Request(`http://localhost/api/copilotkit${path}`, {
          method: 'POST',
        }),
        store,
        { threadId: 'bound' },
      ),
    ).toThrow();
  }
  expect(() =>
    validateRuntimeScope(
      new Request(
        `http://localhost/api/copilotkit/agent/${dot.id}/stop/bound`,
        { method: 'POST' },
      ),
      store,
      {},
    ),
  ).not.toThrow();
  expect(() =>
    validateRuntimeScope(
      new Request('http://localhost/api/copilotkit/threads/bound/messages'),
      store,
      null,
    ),
  ).not.toThrow();
  store.close();
});
