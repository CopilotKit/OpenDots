import { spawn } from 'node:child_process';
import type { ComputerAction } from '../shared/computer-types.js';

// A computer ploop reaches over SSH: any Linux machine the owner can log in
// to, such as an always-free cloud VM, a spare computer or a local VM. It uses
// the `ssh` program and a key file already on the server, so ploop never stores
// or sees the key itself. It has a shell and files, but no browser.
export interface SshTarget {
  host: string;
  user: string;
  port: number;
  keyPath: string;
}

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const OUTPUT_LIMIT = 200_000;

export function sshTargetFromEnv(
  env: Record<string, string | undefined>,
): SshTarget | undefined {
  const host = env.PLOOP_SSH_HOST?.trim();
  if (!host) return undefined;
  const user = env.PLOOP_SSH_USER?.trim() || 'ploop';
  const port = Number(env.PLOOP_SSH_PORT?.trim() || 22);
  const keyPath = env.PLOOP_SSH_KEY_PATH?.trim() ?? '';
  if (!HOST_PATTERN.test(host))
    throw new Error('PLOOP_SSH_HOST doesn’t look like a host name or address.');
  if (!USER_PATTERN.test(user))
    throw new Error('PLOOP_SSH_USER doesn’t look like a user name.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PLOOP_SSH_PORT must be between 1 and 65535.');
  if (keyPath && !keyPath.startsWith('/'))
    throw new Error('PLOOP_SSH_KEY_PATH must be a full path.');
  return { host, user, port, keyPath };
}

export function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sshArgs(target: SshTarget) {
  return [
    '-p',
    String(target.port),
    ...(target.keyPath
      ? ['-i', target.keyPath, '-o', 'IdentitiesOnly=yes']
      : []),
    // Never stop to ask a question; fail with a message instead.
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '--',
    `${target.user}@${target.host}`,
    // The script arrives on stdin, so nothing is parsed by the remote login shell.
    'bash -s',
  ];
}

export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type SshRun = (
  target: SshTarget,
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<SshResult>;

export const runOverSsh: SshRun = (target, script, { timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const child = spawn('ssh', sshArgs(target), {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const capture = (chunks: Buffer[]) => {
      let size = 0;
      return (chunk: Buffer) => {
        if (size >= OUTPUT_LIMIT) return;
        size += chunk.length;
        chunks.push(chunk);
      };
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.stdin.on('error', () => {});
    child.once('error', (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('The server doesn’t have the ssh program installed.')
          : timeout.aborted
            ? new Error('The SSH computer took too long to answer.')
            : new Error('The SSH computer request was cancelled.'),
      ),
    );
    child.once('close', (code) => {
      const text = (chunks: Buffer[]) =>
        Buffer.concat(chunks).toString('utf8').slice(0, OUTPUT_LIMIT);
      if (code === 255)
        return reject(
          new Error(
            `Couldn’t reach the SSH computer: ${text(stderr).trim() || 'connection failed'}`,
          ),
        );
      resolve({
        exitCode: code ?? 1,
        stdout: text(stdout),
        stderr: text(stderr),
      });
    });
    child.stdin.end(script);
  });

// Each Dot works in its own folder in the SSH user's home directory.
export function sshWorkspace(dotId: string) {
  return `ploop/${dotId}`;
}

// `exec bash` with no stdin keeps a command that reads input from swallowing
// the rest of the script. Trusted commands of ours that carry large data run
// directly instead, because one argument to `bash -c` is limited to 128 KB.
function inWorkspace(dotId: string, command: string, direct = false) {
  const workspace = quote(sshWorkspace(dotId));
  return `mkdir -p -- ${workspace} && cd -- ${workspace} || exit 1\n${direct ? command : `exec bash -c ${quote(command)} </dev/null`}\n`;
}

export class SshComputer {
  constructor(
    readonly target: SshTarget,
    private run: SshRun = runOverSsh,
  ) {}
  get description() {
    return `${this.target.user}@${this.target.host} over SSH`;
  }
  async prepare(dotId: string, signal?: AbortSignal) {
    const result = await this.run(this.target, inWorkspace(dotId, 'true'), {
      timeoutMs: 30_000,
      signal,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `The SSH computer couldn’t create the workspace folder: ${result.stderr.trim()}`,
      );
  }
  async action(
    dotId: string,
    action: ComputerAction,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = typeof input.path === 'string' ? input.path : '';
    const target = quote(path || '.');
    if (action === 'exec') {
      const result = await this.run(
        this.target,
        inWorkspace(dotId, String(input.command)),
        { timeoutMs: Number(input.timeoutMs ?? 30_000) + 15_000, signal },
      );
      return result;
    }
    if (action === 'files_list') {
      const result = await this.run(
        this.target,
        inWorkspace(
          dotId,
          `find ${target} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n' | sort -k3 | head -n 500`,
        ),
        { timeoutMs: 30_000, signal },
      );
      if (result.exitCode !== 0)
        throw new Error(`Couldn’t list ${path || 'the workspace'}.`);
      return {
        path,
        entries: result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [type, size, name] = line.split('\t');
            return {
              name,
              type: type === 'd' ? 'directory' : 'file',
              size: Number(size),
            };
          }),
      };
    }
    if (action === 'files_read') {
      const result = await this.run(
        this.target,
        inWorkspace(
          dotId,
          `test -f ${target} || exit 44; head -c ${OUTPUT_LIMIT - 1000} -- ${target}`,
        ),
        { timeoutMs: 30_000, signal },
      );
      if (result.exitCode === 44) throw new Error(`${path} doesn’t exist.`);
      if (result.exitCode !== 0) throw new Error(`Couldn’t read ${path}.`);
      return { path, contents: result.stdout };
    }
    if (action === 'files_write') {
      // base64 keeps the file's bytes from being read as part of the script.
      const encoded = Buffer.from(String(input.contents)).toString('base64');
      const result = await this.run(
        this.target,
        inWorkspace(
          dotId,
          `mkdir -p -- "$(dirname -- ${target})" && printf %s ${quote(encoded)} | base64 -d ${input.append ? '>>' : '>'} ${target}`,
          true,
        ),
        { timeoutMs: 30_000, signal },
      );
      if (result.exitCode !== 0) throw new Error(`Couldn’t save ${path}.`);
      return { path, saved: true };
    }
    throw new Error(
      'This computer is linked over SSH and has no browser. Use search_web for web pages.',
    );
  }
}
