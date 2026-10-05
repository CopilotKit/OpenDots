import { expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  intelligenceApiKeyFromEnv,
  intelligenceWsUrlFromEnv,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const configured: PlatformConfig = {
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};

it('accepts the CLI project key and still accepts the template name', () => {
  expect(
    intelligenceApiKeyFromEnv({ CPK_INTELLIGENCE_API_KEY: 'cpk-from-cli' }),
  ).toBe('cpk-from-cli');
  expect(intelligenceApiKeyFromEnv({ INTELLIGENCE_API_KEY: 'legacy' })).toBe(
    'legacy',
  );
  expect(
    intelligenceApiKeyFromEnv({
      CPK_INTELLIGENCE_API_KEY: 'cpk-from-cli',
      INTELLIGENCE_API_KEY: 'legacy',
    }),
  ).toBe('cpk-from-cli');
  expect(
    intelligenceApiKeyFromEnv({
      CPK_INTELLIGENCE_API_KEY: '   ',
      INTELLIGENCE_API_KEY: 'legacy',
    }),
  ).toBe('legacy');
  expect(intelligenceApiKeyFromEnv({})).toBeUndefined();
});

it('reports either accepted name from the same label used by setup status and the copilotkit error', async () => {
  const key = intelligenceApiKeyFromEnv({
    CPK_INTELLIGENCE_API_KEY: 'cpk-from-cli',
  });
  expect(setupStatus({ ...configured, intelligenceKey: key })).toMatchObject({
    intelligence: true,
    missing: [],
  });
  expect(INTELLIGENCE_KEY_MISSING_LABEL).toContain('CPK_INTELLIGENCE_API_KEY');
  expect(INTELLIGENCE_KEY_MISSING_LABEL).toContain('INTELLIGENCE_API_KEY');
  expect(setupStatus(configured).missing).toContain(
    INTELLIGENCE_KEY_MISSING_LABEL,
  );

  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const platform = new Platform(store, workspace, configured);
    const response = await platform.handle(
      new Request('http://127.0.0.1/api/copilotkit/info'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: `Setup required: ${INTELLIGENCE_KEY_MISSING_LABEL}.`,
    });
    expect(platform.setup().missing).toContain(INTELLIGENCE_KEY_MISSING_LABEL);
  } finally {
    store.close();
    workspace.close();
  }
});

it('uses the local CLI gateway URL instead of a stale hosted override', () => {
  expect(
    intelligenceWsUrlFromEnv({
      INTELLIGENCE_GATEWAY_WS_URL: ' ws://localhost:5080 ',
      INTELLIGENCE_WS_URL: 'wss://hosted.example.com',
    }),
  ).toBe('ws://localhost:5080');
});

it('keeps the existing WebSocket override when the CLI value is absent or blank', () => {
  expect(
    intelligenceWsUrlFromEnv({
      INTELLIGENCE_WS_URL: ' wss://hosted.example.com ',
    }),
  ).toBe('wss://hosted.example.com');
  expect(
    intelligenceWsUrlFromEnv({
      INTELLIGENCE_GATEWAY_WS_URL: '   ',
      INTELLIGENCE_WS_URL: 'ws://localhost:5080',
    }),
  ).toBe('ws://localhost:5080');
  expect(intelligenceWsUrlFromEnv({})).toBeUndefined();
  expect(
    intelligenceWsUrlFromEnv({ INTELLIGENCE_GATEWAY_WS_URL: '  ' }),
  ).toBeUndefined();
});
