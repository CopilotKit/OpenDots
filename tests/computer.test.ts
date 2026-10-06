import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerInputs } from '../src/shared/computer-types.js';
import { computerTools } from '../src/server/computer-tools.js';
const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(deadline = 1000) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const calls: { url: string; init?: RequestInit }[] = [];
  let paused = false;
  let endpoint: string | undefined;
  let actionHandler: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json({ text: 'result' });
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/computers'))
      return Response.json({
        computers: workspace.dots().map((dot) => ({
          botId: dot.id,
          container: `opendots-computer-${dot.id}`,
          status: 'running',
          ...(endpoint ? { url: endpoint } : {}),
        })),
      });
    if (url.endsWith('/ensure'))
      return Response.json({
        botId: id,
        container: `opendots-computer-${id}`,
        status: 'running',
        url: `http://opendots-computer-${id}:4100`,
      });
    if (url.endsWith('/control'))
      return Response.json({
        holder: 'human',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        request: { id: 'request', status: 'taken' },
      });
    return actionHandler(url, init);
  };
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
  };
  const service = new ComputerService(
    workspace,
    config,
    () => paused,
    transport,
    deadline,
  );
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return {
    workspace,
    id,
    service,
    calls,
    config,
    transport,
    setPaused: (value: boolean) => {
      paused = value;
    },
    setEndpoint: (value: string) => {
      endpoint = value;
    },
    handle: (fn: typeof actionHandler) => {
      actionHandler = fn;
    },
  };
}
it('defaults every permission off and persists policy and metadata-only audit across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'computers-'));
  const path = join(dir, 'db');
  let workspace = new WorkspaceStore(path, 'owner');
  const id = workspace.dots()[0].id;
  expect(workspace.computers.permissions(id)).toEqual({
    enabled: false,
    browser: false,
    files: false,
    shell: false,
  });
  workspace.computers.patch(id, { enabled: true, files: true });
  const audit = workspace.computers.begin(id, 'files_write', 'agent');
  workspace.computers.finish(audit, 'succeeded');
  workspace.close();
  workspace = new WorkspaceStore(path, 'owner');
  expect(workspace.computers.permissions(id).files).toBe(true);
  expect(workspace.computers.audit(id)[0]).toMatchObject({
    action: 'files_write',
    outcome: 'succeeded',
  });
  workspace.close();
  rmSync(dir, { recursive: true });
});
it('status never provisions and actions use per-Dot derived credentials with audit before dispatch', async () => {
  const f = fixture();
  f.config.computerToken = '  master-secret  ';
  await f.service.status(f.id);
  expect(f.calls.every((call) => !call.url.endsWith('/ensure'))).toBe(true);
  f.handle(async () => {
    expect(f.workspace.computers.audit(f.id)[0].outcome).toBe('pending');
    return Response.json({ text: f.config.computerToken.trim() });
  });
  expect(
    await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent'),
  ).toEqual({ text: '[redacted]' });
  const request = f.calls.find((call) => call.url.endsWith('/files/read'))!;
  expect(new Headers(request.init?.headers).get('authorization')).toBe(
    `Bearer ${createHmac('sha256', 'master-secret').update(`opendots-computer:${f.id}`).digest('hex')}`,
  );
  expect(new Headers(request.init?.headers).get('x-openbot-bot-id')).toBe(f.id);
  expect(request.init?.redirect).toBe('error');
  f.handle(async () => Response.json({ text: 'result' }));
  const other = f.workspace.createDot(
    f.workspace.spaces()[0].id,
    'Other',
    '',
    true,
    true,
  );
  f.workspace.computers.patch(other.id, { enabled: true, files: true });
  await f.service.action(other.id, 'files_read', { path: 'note.txt' });
  const last = f.calls.at(-1)!;
  expect(new Headers(last.init?.headers).get('authorization')).not.toBe(
    new Headers(request.init?.headers).get('authorization'),
  );
  expect(last.url).toContain(other.id);
});
it('rejects foreign targets, nonexistent Dots, traversal, unexpected inputs and agent human controls', async () => {
  const f = fixture();
  f.setEndpoint('http://attacker.test:4100');
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('endpoint');
  expect(f.calls).toHaveLength(1);
  await expect(f.service.action('missing', 'read', {})).rejects.toThrow(
    'Dot not found',
  );
  for (const path of [
    '../secret',
    'a/../../secret',
    '/etc/passwd',
    'a\\secret',
    'a\0b',
  ])
    expect(computerInputs.files_read.safeParse({ path }).success).toBe(false);
  expect(
    computerInputs.exec.safeParse({ command: 'pwd', timeoutMs: 60001 }).success,
  ).toBe(false);
  expect(
    computerInputs.read.safeParse({ url: 'http://elsewhere' }).success,
  ).toBe(false);
  await expect(
    f.service.action(f.id, 'human_type', { text: 'secret' }, 'agent'),
  ).rejects.toThrow('owner-only');
});
it('checks current permissions and global pause and records failure without sensitive inputs', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, { shell: false });
  await expect(
    f.service.action(f.id, 'exec', { command: 'sensitive command' }, 'agent'),
  ).rejects.toThrow('permission');
  f.setPaused(true);
  await expect(f.service.action(f.id, 'read', {}, 'agent')).rejects.toThrow(
    'paused',
  );
  expect(f.calls).toHaveLength(0);
  expect(JSON.stringify(f.workspace.computers.audit(f.id))).not.toContain(
    'sensitive',
  );
  expect(
    f.workspace.computers.audit(f.id).every((a) => a.outcome === 'failed'),
  ).toBe(true);
});
it('cancels in-flight actions on revocation and bounds upstream deadlines', async () => {
  const f = fixture(200);
  f.handle(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      }),
  );
  const run = f.service.action(f.id, 'exec', { command: 'wait' }, 'agent');
  setTimeout(() => f.workspace.computers.patch(f.id, { shell: false }), 20);
  await expect(run).rejects.toThrow('cancelled or timed out');
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
    'cancelled or timed out',
  );
  expect(
    f.workspace.computers.audit(f.id).every((a) => a.outcome === 'failed'),
  ).toBe(true);
});
it('preserves recovery handback after permissions are revoked; upstream failures are sanitized', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, { enabled: false, browser: false });
  await f.service.control(f.id, 'release');
  expect(f.calls.some((call) => call.url.endsWith('/control/release'))).toBe(
    true,
  );
  f.workspace.computers.patch(f.id, { enabled: true, browser: true });
  f.handle(async () =>
    Response.json({ error: 'secret upstream detail' }, { status: 500 }),
  );
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('HTTP 500');
  f.handle(async () => new Response('x'.repeat(4_000_001)));
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
    'size limit',
  );
});
it('binds tools to the current Dot without exposing human or policy controls', async () => {
  const f = fixture();
  const check = vi.fn();
  const tools = computerTools(
    f.service,
    f.id,
    check,
    new AbortController().signal,
  );
  expect(
    tools.some(
      (t) => t.name.includes('human') || t.name.includes('permission'),
    ),
  ).toBe(false);
  const read = tools.find((t) => t.name === 'computer_files_read')!;
  await read.execute?.({ path: 'notes.txt' });
  expect(check).toHaveBeenCalled();
  expect(f.calls.at(-1)?.url).toContain(f.id);
});
it('bounds completed audit storage while preserving pending work', () => {
  const f = fixture();
  const pending = f.workspace.computers.begin(f.id, 'exec', 'agent');
  for (let i = 0; i < 1010; i++)
    f.workspace.computers.finish(
      f.workspace.computers.begin(f.id, 'read', 'owner'),
      'succeeded',
    );
  f.workspace.computers.finish(pending, 'failed');
  expect(f.workspace.computers.audit(f.id)).toHaveLength(50);
});

it('accepts an uppercase namespace while preserving exact container identity', async () => {
  const f = fixture();
  const config = { ...f.config, computerNamespace: 'MyDots' };
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/computers'))
      return Response.json({
        computers: [
          {
            botId: f.id,
            container: `MyDots-computer-${f.id}`,
            status: 'running',
            url: `http://MyDots-computer-${f.id}:4100`,
          },
        ],
      });
    return f.transport(input, init);
  };
  const service = new ComputerService(
    f.workspace,
    config,
    () => false,
    transport,
  );
  await expect(service.action(f.id, 'read', {})).resolves.toEqual({
    text: 'result',
  });
  expect(f.calls.at(-1)?.url).toBe(`http://mydots-computer-${f.id}:4100/read`);
});

it('gives agents a safe recovery instruction for stale browser or control conflicts', async () => {
  const f = fixture();
  f.handle(async () =>
    Response.json({ error: f.config.computerToken }, { status: 409 }),
  );
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.toThrow('computer_snapshot');
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.not.toThrow(f.config.computerToken);
  expect(f.workspace.computers.audit(f.id)[0].outcome).toBe('failed');
});

it('keeps the owner screen refresh out of the activity log unless it fails', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.service.action(f.id, 'screenshot', {});
  expect(f.workspace.computers.audit(f.id)).toEqual([]);
  await f.service.action(f.id, 'read', {}, 'agent');
  await f.service.action(f.id, 'screenshot', {}, 'agent');
  expect(
    f.workspace.computers.audit(f.id).map((a) => [a.action, a.actor]),
  ).toEqual([
    ['screenshot', 'agent'],
    ['read', 'agent'],
  ]);
  f.handle(async () => Response.json({ error: 'down' }, { status: 500 }));
  await expect(f.service.action(f.id, 'screenshot', {})).rejects.toThrow();
  expect(f.workspace.computers.audit(f.id)[0]).toMatchObject({
    action: 'screenshot',
    actor: 'owner',
    outcome: 'failed',
  });
});
