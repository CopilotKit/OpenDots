import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { HostShellService } from '../src/server/host-shell.js';

const stores: { close(): void }[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const config = {
  baseUrl: 'https://example.com',
  voiceName: 'voice',
  slackUsers: [],
  runtimeUrl: 'http://localhost',
  unsafeHostShell: {
    enabled: true,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
  },
};

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(store, workspace);
  const dot = workspace.dots()[0];
  const thread = workspace.bindThread('thread', dot.id, 'Thread');
  workspace.updateDot(dot.id, { ...dot, unsafeHostShellAllowed: true });
  const platform = new Platform(store, workspace, config);
  const runner = new Runner(store, { mode: 'sample', baseUrl: config.baseUrl });
  const app = createApp({
    store,
    runner,
    config: { mode: 'sample', baseUrl: config.baseUrl },
    platform,
  });
  return { store, workspace, dot: workspace.dot(dot.id)!, thread, platform, app };
}

it('is disabled unless both the server and the Dot allow it', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const dot = workspace.dots()[0];
  const disabledServer = new HostShellService(workspace, {
    ...config,
    unsafeHostShell: { ...config.unsafeHostShell, enabled: false },
  });
  expect(disabledServer.available(dot.id)).toBe(false);
  expect(() => disabledServer.assertAvailable(dot.id)).toThrow('disabled');

  const enabledServer = new HostShellService(workspace, config);
  expect(enabledServer.available(dot.id)).toBe(false);
  workspace.updateDot(dot.id, { ...dot, unsafeHostShellAllowed: true });
  expect(enabledServer.available(dot.id)).toBe(true);
});

it('stores exact approval command details for later owner execution', () => {
  const { workspace, dot } = fixture();
  const service = new HostShellService(workspace, config);
  const input = service.normalize({ command: 'printf hello' });
  const approvalId = workspace.hostShell.createApproval({
    threadId: 'thread',
    dotId: dot.id,
    ...input,
  });
  expect(workspace.hostShell.approval(approvalId)).toMatchObject({
    command: 'printf hello',
    dotId: dot.id,
    cwd: process.cwd(),
  });
});

it('runs the stored command only once after owner approval', async () => {
  const { app, workspace, dot } = fixture();
  const approvalId = workspace.hostShell.createApproval({
    threadId: 'thread',
    dotId: dot.id,
    command: 'node -e "process.stdout.write(\'ok\')"',
    cwd: process.cwd(),
    timeoutMs: 3000,
  });
  const preview = await app.request(
    `/api/conversations/thread/host-shell-approvals/${approvalId}`,
  );
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ command: expect.stringContaining('ok') });

  const first = await app.request('/api/conversations/thread/host-shell-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId, toolCallId: 'call-1' }),
  });
  expect(first.status).toBe(200);
  const body = (await first.json()) as { isError: boolean; text: string };
  expect(body.isError).toBe(false);
  expect(body.text).toContain('ok');

  const again = await app.request('/api/conversations/thread/host-shell-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId, toolCallId: 'call-2' }),
  });
  expect(again.status).toBe(409);
});

it('captures nonzero exits and timeouts as errors', async () => {
  const { platform } = fixture();
  const fail = await platform.hostShell.execute({
    command: 'node -e "process.stderr.write(\'bad\'); process.exit(2)"',
    cwd: process.cwd(),
    timeoutMs: 3000,
  });
  expect(fail.isError).toBe(true);
  expect(fail.text).toContain('bad');
  expect(fail.text).toContain('2');

  const timeout = await platform.hostShell.execute({
    command: 'node -e "setTimeout(() => {}, 5000)"',
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  expect(timeout.isError).toBe(true);
  expect(timeout.text).toContain('timedOut');
});
