import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
// Disable SDK startup telemetry before its module initializes. Fetch spies cover provider traffic.
vi.hoisted(() => vi.stubEnv('COPILOTKIT_TELEMETRY_DISABLED', 'true'));
afterAll(() => vi.unstubAllEnvs());
const base: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
it('never claims Slack online without a complete managed channel declaration', () => {
  expect(setupStatus(base, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...base, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...base,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('requires Intelligence and model setup and disables voice when either is absent', () => {
  expect(
    setupStatus({
      ...base,
      intelligenceKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ missing: ['INTELLIGENCE_API_KEY'], voice: false });
});
it('accepts each provider slot and harness host login without API keys', () => {
  const noKeys: PlatformConfig = {
    ...base,
    apiKey: undefined,
    model: undefined,
  };
  expect(setupStatus(noKeys).model).toBe(false);
  expect(
    setupStatus({
      ...noKeys,
      modelProvider: 'anthropic',
      anthropicKey: 'a',
      anthropicModel: 'claude-sonnet-5-5',
    }).model,
  ).toBe(true);
  expect(
    setupStatus({
      ...noKeys,
      modelProvider: 'cline-pass',
      clineKey: 'c',
      clineModel: 'cline-pass/qwen3.7-max',
    }).model,
  ).toBe(true);
  // Subscription harnesses: host CLI login owns auth, no key required.
  expect(
    setupStatus({
      ...noKeys,
      modelProvider: 'claude-code',
      claudeAuthMode: 'host',
      claudeModel: 'claude-sonnet-5-5',
    }).model,
  ).toBe(true);
  expect(
    setupStatus({
      ...noKeys,
      modelProvider: 'codex',
      codexAuthMode: 'host',
      codexModel: 'gpt-5.2-codex',
    }).model,
  ).toBe(true);
});
it('requires the active provider instead of accepting an unrelated filled slot', () => {
  expect(setupStatus({ ...base, modelProvider: 'anthropic' })).toMatchObject({
    model: false,
    missing: ['Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL.'],
  });
  expect(
    setupStatus({
      ...base,
      modelProvider: 'cline-pass',
      anthropicKey: 'fixture',
      anthropicModel: 'fixture',
    }).model,
  ).toBe(false);
  expect(
    setupStatus({
      ...base,
      apiKey: undefined,
      model: undefined,
      anthropicKey: 'fixture',
      anthropicModel: 'fixture',
    }).model,
  ).toBe(false);
  expect(
    setupStatus({
      ...base,
      modelProvider: 'claude-code',
      claudeAuthMode: 'host',
    }).model,
  ).toBe(false);
  expect(
    setupStatus({ ...base, modelProvider: 'codex', codexAuthMode: 'host' })
      .model,
  ).toBe(false);
});
it('treats whitespace, invalid authentication, and retired selections as incomplete setup', () => {
  expect(setupStatus({ ...base, apiKey: ' ' }).model).toBe(false);
  expect(setupStatus({ ...base, model: ' ' }).model).toBe(false);
  expect(setupStatus({ ...base, intelligenceKey: ' ' }).intelligence).toBe(
    false,
  );
  expect(
    setupStatus({
      ...base,
      modelProvider: 'codex',
      codexModel: 'fixture',
      codexAuthMode: 'api-key',
    }).model,
  ).toBe(false);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    expect(setupStatus({ ...base, model: 'gpt-5.5' }).model).toBe(false);
    expect(
      setupStatus({ ...base, modelProvider: 'codex', codexModel: 'gpt-5.5' })
        .model,
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});
function appFor(config: PlatformConfig) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
  close.push(() => {
    store.close();
    workspace.close();
  });
  const platform = new Platform(store, workspace, config);
  const researchConfig = { mode: 'sample' as const, baseUrl: config.baseUrl };
  const app = createApp({
    store,
    platform,
    config: researchConfig,
    runner: new Runner(store, researchConfig),
  });
  return { app, store, workspace };
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
it.each<Partial<PlatformConfig>>([
  { modelProvider: 'anthropic' },
  { modelProvider: 'claude-code', claudeAuthMode: 'host' },
  { modelProvider: 'codex', codexAuthMode: 'host' },
  { apiKey: ' ' },
  { model: ' ' },
  { modelProvider: 'codex', codexModel: 'fixture', codexAuthMode: 'api-key' },
])(
  'keeps missing active configuration behind actual route 503 guards: %j',
  async (selection) => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network call');
    });
    vi.stubGlobal('fetch', fetch);
    const { app, store, workspace } = appFor({ ...base, ...selection });
    const dot = workspace.dots()[0];
    workspace.bindThread('fixture-thread', dot.id, 'Fixture');
    const conversation = await app.request(
      '/api/conversations',
      post({ dotId: dot.id }),
    );
    expect(conversation.status).toBe(503);
    expect(await conversation.json()).toHaveProperty(
      'error',
      expect.stringContaining('Setup required'),
    );
    expect(
      (
        await app.request(
          '/api/tasks',
          post({ prompt: 'Fixture research', threadId: 'fixture-thread' }),
        )
      ).status,
    ).toBe(503);
    const page = workspace.pages.create(dot.spaceId, {
      title: 'Fixture page',
      content: 'Fixture',
    });
    expect(
      (
        await app.request(
          `/api/spaces/${dot.spaceId}/pages/${page.id}/conversation`,
          post({ dotId: dot.id }),
        )
      ).status,
    ).toBe(503);
    expect(store.tasks()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('accepts a scheduled task through the same route when the selected provider is complete', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Unexpected network call');
  });
  vi.stubGlobal('fetch', fetch);
  const { app, store, workspace } = appFor({
    ...base,
    modelProvider: 'anthropic',
    anthropicKey: 'fixture',
    anthropicModel: 'fixture',
  });
  workspace.bindThread('fixture-thread', workspace.dots()[0].id, 'Fixture');
  expect(
    (
      await app.request(
        '/api/tasks',
        post({ prompt: 'Fixture research', threadId: 'fixture-thread' }),
      )
    ).status,
  ).toBe(201);
  expect(store.tasks()).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('reports activation failure until the SDK recovers online', () => {
  const declared = {
    ...base,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
});
