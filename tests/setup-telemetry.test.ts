import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType } from '@ag-ui/core';
import { expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import {
  SetupTelemetry,
  setupInputSchema,
  answerObserver,
} from '../src/server/setup-telemetry.js';

it('persists bounded offline events with stable IDs and CLI identity across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-telemetry-'));
  const path = join(dir, 'store.sqlite');
  let store = new Store(path);
  const offline = vi.fn(async () => {
    throw new Error('secret transport error');
  });
  const diagnostics = vi.fn();
  const env = { CPK_TELEMETRY_ID: 'cli-identity' };
  let telemetry = new SetupTelemetry(store, env, offline, diagnostics);
  for (let i = 0; i < 260; i++)
    telemetry.capture({ kind: 'step_viewed', step: 'ready' });
  await telemetry.flush();
  const state = JSON.parse(store.setupTelemetryState()!);
  expect(state.queue).toHaveLength(256);
  expect(diagnostics).toHaveBeenCalledWith('delivery_failed');
  const id = state.queue[1].id; // Recovery abandonment drops the oldest full-queue entry.
  const installationId = state.installationId;
  store.close();
  store = new Store(path);
  const requests: { identity: string; body: unknown }[] = [];
  telemetry = new SetupTelemetry(
    store,
    env,
    async (identity, body) => {
      requests.push({ identity, body });
    },
    diagnostics,
  );
  await telemetry.flush();
  expect(requests[0].identity).toBe('cli-identity');
  expect(requests[0].body).toMatchObject({ ts: state.queue[1].occurredAt });
  expect(state.queue[1].occurredAt).toBeLessThan(100_000_000_000);
  expect(requests[0].body).toMatchObject({
    event_id: id,
    event: 'oss.runtime.setup_step_viewed',
    global_properties: {
      accessibility_title: 'OpenDots',
      opendots_distribution: 'web',
      installation_id: installationId,
    },
  });
  expect(JSON.parse(store.setupTelemetryState()!).queue).toEqual([]);
  expect(JSON.stringify(requests)).not.toContain('secret transport error');
  store.close();
  rmSync(dir, { recursive: true });
});

it.each(['DO_NOT_TRACK', 'COPILOTKIT_TELEMETRY_DISABLED'])(
  'purges pending telemetry for both true and 1 in %s',
  async (key) => {
    for (const value of ['true', '1']) {
      const store = new Store(':memory:');
      const env: Record<string, string> = {};
      const send = vi.fn(async () => {});
      const telemetry = new SetupTelemetry(store, env, send);
      telemetry.capture({ kind: 'step_viewed', step: 'setup_required' });
      env[key] = value;
      await telemetry.flush();
      telemetry.capture({ kind: 'activated' });
      expect(store.setupTelemetryState()).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      store.close();
    }
  },
);

it('reuses fallback identity and recovers abandonment without treating ready as activated', () => {
  const store = new Store(':memory:');
  const first = new SetupTelemetry(store, {}, async () => {});
  first.capture({ kind: 'step_viewed', step: 'ready' });
  const second = new SetupTelemetry(store, {}, async () => {});
  expect(second.identity).toBe(first.identity);
  const state = JSON.parse(store.setupTelemetryState()!);
  expect(state.activated).toBe(false);
  expect(state.queue.at(-1).event).toEqual({
    kind: 'setup_abandoned',
    step: 'ready',
  });
  second.capture({ kind: 'activated' });
  second.capture({ kind: 'activated' });
  expect(
    JSON.parse(store.setupTelemetryState()!).queue.filter(
      (q: { event: { kind: string } }) => q.event.kind === 'activated',
    ),
  ).toHaveLength(1);
  store.close();
});

it('rejects forged activation and every unknown property or enum in client input', () => {
  for (const input of [
    { kind: 'activated' },
    { kind: 'step_viewed', step: 'ready', prompt: 'secret' },
    { kind: 'step_viewed', step: 'private/path' },
    { kind: 'setup_failed', step: 'ready', error: 'secret' },
  ])
    expect(setupInputSchema.safeParse(input).success).toBe(false);
  expect(
    setupInputSchema.safeParse({ kind: 'step_viewed', step: 'settings' })
      .success,
  ).toBe(true);
});

it('activates only after a successful assistant answer and records a bounded failure', () => {
  const capture = vi.fn();
  const observe = answerObserver(capture);
  observe({ type: EventType.RUN_FINISHED });
  expect(capture).not.toHaveBeenCalled();
  const failed = answerObserver(capture);
  failed({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'answer',
    role: 'assistant',
  });
  failed({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'answer',
    delta: 'secret answer',
  });
  failed({ type: EventType.RUN_ERROR, message: 'secret error' });
  failed({ type: EventType.RUN_FINISHED });
  expect(capture).toHaveBeenCalledExactlyOnceWith({
    kind: 'setup_failed',
    step: 'ready',
    error_class: 'assistant_run_failed',
  });
  const success = answerObserver(capture);
  success({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'answer',
    role: 'assistant',
  });
  success({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'answer',
    delta: 'real answer',
  });
  success({ type: EventType.RUN_FINISHED });
  expect(capture).toHaveBeenLastCalledWith({ kind: 'activated' });
});

it('protects the browser route with owner auth and origin guards and rejects forged readiness', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
  const platform = new Platform(store, workspace, {
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  const config = { mode: 'sample' as const, baseUrl: '' };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'fixture-token',
    platform,
  });
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/setup-telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const headers = { Authorization: 'Bearer fixture-token' };
  expect(
    (await request({ kind: 'step_viewed', step: 'setup_required' })).status,
  ).toBe(401);
  expect(
    (
      await request(
        { kind: 'step_viewed', step: 'setup_required' },
        { ...headers, Origin: 'https://evil.example' },
      )
    ).status,
  ).toBe(403);
  expect((await request({ kind: 'activated' }, headers)).status).toBe(400);
  expect(
    (await request({ kind: 'step_viewed', step: 'ready' }, headers)).status,
  ).toBe(400);
  expect(
    (
      await request(
        { kind: 'step_viewed', step: 'setup_required', key: 'secret' },
        headers,
      )
    ).status,
  ).toBe(400);
  expect(
    (await request({ kind: 'step_viewed', step: 'setup_required' }, headers))
      .status,
  ).toBe(200);
  store.close();
  workspace.close();
});

it('does not activate from user text, partial answers or tool-only success', () => {
  const capture = vi.fn();
  const user = answerObserver(capture);
  user({ type: EventType.TEXT_MESSAGE_START, messageId: 'user', role: 'user' });
  user({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'user',
    delta: 'prompt',
  });
  user({ type: EventType.RUN_FINISHED });
  const partial = answerObserver(capture);
  partial({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'answer',
    role: 'assistant',
  });
  partial({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'answer',
    delta: 'partial answer',
  });
  expect(capture).not.toHaveBeenCalled();
});

it('uses installation fallback after a CLI identity is removed, and never loses CLI precedence', () => {
  const store = new Store(':memory:');
  const cli = new SetupTelemetry(
    store,
    { CPK_TELEMETRY_ID: 'cli-one' },
    async () => {},
  );
  expect(cli.identity).toBe('cli-one');
  const fallback = new SetupTelemetry(store, {}, async () => {});
  expect(fallback.identity).toBe(cli.metadata.installation_id);
  const replacement = new SetupTelemetry(
    store,
    { CPK_TELEMETRY_ID: 'cli-two' },
    async () => {},
  );
  expect(replacement.identity).toBe('cli-two');
  expect(replacement.metadata.installation_id).toBe(
    cli.metadata.installation_id,
  );
  store.close();
});

it('bounds a shutdown flush and retains events that did not fit its deadline', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  try {
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const telemetry = new SetupTelemetry(store, {}, send);
    for (let i = 0; i < 10; i++)
      telemetry.capture({ kind: 'step_viewed', step: 'ready' });
    const stopped = telemetry.stop();
    await vi.advanceTimersByTimeAsync(3500);
    await stopped;
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.setupTelemetryState()!).queue).toHaveLength(9); // includes abandonment
  } finally {
    vi.useRealTimers();
    store.close();
  }
});
