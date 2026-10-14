import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  use: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock('@composio/core', () => ({
  Composio: class {
    sessions = { create: sdk.create, use: sdk.use };
    constructor(options: unknown) {
      sdk.constructor(options);
    }
  },
}));

const config: PlatformConfig = {
  composioApiKey: 'composio-fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
const stores: WorkspaceStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.clearAllMocks();
});

it('creates a non-Instant session and reuses it while the policy is unchanged', async () => {
  const { composioSession } = await import('../src/server/composio.js');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const original = workspace.dots()[0];
  workspace.updateDot(original.id, {
    ...original,
    appsAllowed: true,
    composioToolkits: ['gmail'],
  });
  const created = { sessionId: 'session-one' };
  sdk.create.mockResolvedValue(created);
  sdk.use.mockResolvedValue(created);

  await expect(
    composioSession(config, workspace, workspace.dot(original.id)!, 'owner'),
  ).resolves.toBe(created);
  expect(sdk.create).toHaveBeenCalledWith('owner', {
    toolkits: ['gmail'],
    manageConnections: true,
    instant: false,
  });

  await composioSession(
    config,
    workspace,
    workspace.dot(original.id)!,
    'owner',
  );
  expect(sdk.create).toHaveBeenCalledTimes(1);
  expect(sdk.use).toHaveBeenCalledWith('session-one');
});

it('creates a new session when the toolkit policy changes', async () => {
  const { composioSession } = await import('../src/server/composio.js');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const dot = workspace.dots()[0];
  sdk.create
    .mockResolvedValueOnce({ sessionId: 'session-one' })
    .mockResolvedValueOnce({ sessionId: 'session-two' });

  await composioSession(config, workspace, dot, 'owner');
  workspace.updateDot(dot.id, {
    ...workspace.dot(dot.id)!,
    composioToolkits: ['gmail'],
  });
  await composioSession(config, workspace, workspace.dot(dot.id)!, 'owner');

  expect(sdk.create).toHaveBeenCalledTimes(2);
  expect(sdk.use).not.toHaveBeenCalled();
  expect(workspace.dot(dot.id)?.composioSessionId).toBe('session-two');
});

it('keeps Composio optional in setup status', async () => {
  const { setupStatus } = await import('../src/server/platform-config.js');
  const without = setupStatus({ ...config, composioApiKey: undefined });
  expect(without.composio).toBe(false);
  expect(without.missing).not.toContain('COMPOSIO_API_KEY');
  expect(setupStatus(config).composio).toBe(true);
});
