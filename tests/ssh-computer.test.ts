import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerTools } from '../src/server/computer-tools.js';
import {
  sshArgs,
  sshTargetFromEnv,
  type SshRun,
} from '../src/server/ssh-computer.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

// Runs the script ploop would send over SSH in a local bash, with a temporary
// directory standing in for the SSH user's home.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ssh-home-'));
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(
    () => workspace.close(),
    () => rmSync(home, { recursive: true, force: true }),
  );
  const scripts: string[] = [];
  const run: SshRun = (_target, script) =>
    new Promise((resolve) => {
      scripts.push(script);
      const child = spawn('bash', ['-s'], { cwd: home });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) =>
        resolve({ exitCode: code ?? 1, stdout, stderr }),
      );
      child.stdin.end(script);
    });
  const id = workspace.dots()[0].id;
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
      sshComputer: { host: 'vm.example', user: 'ploop', port: 22, keyPath: '' },
    },
    () => false,
    fetch,
    1000,
    run,
  );
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return { home, workspace, id, service, scripts };
}

it('reads the SSH computer from the environment and rejects odd values', () => {
  expect(sshTargetFromEnv({})).toBeUndefined();
  expect(
    sshTargetFromEnv({
      PLOOP_SSH_HOST: 'vm.example',
      PLOOP_SSH_KEY_PATH: '/keys/ploop',
    }),
  ).toEqual({
    host: 'vm.example',
    user: 'ploop',
    port: 22,
    keyPath: '/keys/ploop',
  });
  expect(() =>
    sshTargetFromEnv({ PLOOP_SSH_HOST: '-oProxyCommand=x' }),
  ).toThrow();
  expect(() =>
    sshTargetFromEnv({ PLOOP_SSH_HOST: 'vm', PLOOP_SSH_USER: 'a b' }),
  ).toThrow();
  expect(() =>
    sshTargetFromEnv({ PLOOP_SSH_HOST: 'vm', PLOOP_SSH_PORT: '70000' }),
  ).toThrow();
  expect(() =>
    sshTargetFromEnv({ PLOOP_SSH_HOST: 'vm', PLOOP_SSH_KEY_PATH: 'key' }),
  ).toThrow();
  const args = sshArgs({ host: 'vm', user: 'ploop', port: 2222, keyPath: '' });
  expect(args).toContain('BatchMode=yes');
  expect(args.slice(-3)).toEqual(['--', 'ploop@vm', 'bash -s']);
});

it('shows a linked SSH computer as running with no browser tools', async () => {
  const { service, id } = fixture();
  expect(service.configured).toBe(true);
  expect(service.hasBrowser).toBe(false);
  const status = await service.status(id);
  expect(status.state).toBe('running');
  expect(status.link).toBe('ploop@vm.example over SSH');
  const names = computerTools(
    service,
    id,
    () => {},
    new AbortController().signal,
  ).map((tool) => tool.name);
  expect(names.sort()).toEqual([
    'computer_exec',
    'computer_files_list',
    'computer_files_read',
    'computer_files_write',
  ]);
  await expect(service.action(id, 'read', {})).rejects.toThrow(/no browser/);
  await expect(service.control(id, 'take')).rejects.toThrow(/no browser/);
});

it('runs shell commands and file actions in the Dot’s own folder', async () => {
  const { service, id, home } = fixture();
  const written = await service.action(id, 'files_write', {
    path: 'notes/it’s here.txt',
    contents: 'hello $HOME `whoami`\n',
  });
  expect(written).toEqual({ path: 'notes/it’s here.txt', saved: true });
  expect(
    readFileSync(join(home, 'ploop', id, 'notes', 'it’s here.txt'), 'utf8'),
  ).toBe('hello $HOME `whoami`\n');
  await service.action(id, 'files_write', {
    path: 'notes/it’s here.txt',
    contents: 'more',
    append: true,
  });
  expect(
    await service.action(id, 'files_read', { path: 'notes/it’s here.txt' }),
  ).toEqual({
    path: 'notes/it’s here.txt',
    contents: 'hello $HOME `whoami`\nmore',
  });
  expect(await service.action(id, 'files_list', { path: 'notes' })).toEqual({
    path: 'notes',
    entries: [{ name: 'it’s here.txt', type: 'file', size: 25 }],
  });
  await expect(
    service.action(id, 'files_read', { path: 'missing.txt' }),
  ).rejects.toThrow('missing.txt doesn’t exist.');
  const result = (await service.action(id, 'exec', {
    command: 'pwd; read line; echo "read:${line:-none}"; exit 3',
  })) as { exitCode: number; stdout: string };
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe(`${join(home, 'ploop', id)}\nread:none\n`);
});

it('still honors the owner’s computer permissions', async () => {
  const { service, id, workspace, scripts } = fixture();
  workspace.computers.patch(id, { shell: false });
  await expect(
    service.action(id, 'exec', { command: 'echo hi' }, 'agent'),
  ).rejects.toThrow('Computer permission is disabled.');
  expect(scripts).toEqual([]);
});
