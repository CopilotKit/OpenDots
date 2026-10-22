import { spawn } from 'node:child_process';
import { cwd as processCwd } from 'node:process';
import { z } from 'zod';
import { hostShellExecSchema, type HostShellActionResult } from '../shared/host-shell-types.js';
import type { PlatformConfig } from './platform-config.js';
import type { WorkspaceStore } from './workspace.js';

const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;

export const hostShellInput = hostShellExecSchema;

export class HostShellService {
  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    readonly store = workspace.hostShell,
  ) {}

  available(dotId: string) {
    const dot = this.workspace.dot(dotId);
    return !!(
      this.config.unsafeHostShell?.enabled &&
      dot?.unsafeHostShellAllowed
    );
  }

  assertAvailable(dotId: string) {
    const dot = this.workspace.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    if (!this.config.unsafeHostShell?.enabled)
      throw new Error('Unsafe host shell is disabled on this OpenDots server.');
    if (!dot.unsafeHostShellAllowed)
      throw new Error('Unsafe host shell is disabled for this Dot.');
  }

  normalize(input: unknown) {
    const parsed = hostShellInput.parse(input);
    return {
      command: parsed.command,
      cwd: parsed.cwd ?? processCwd(),
      timeoutMs: Math.min(
        parsed.timeoutMs ?? this.config.unsafeHostShell?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.config.unsafeHostShell?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    };
  }

  async execute(input: z.infer<typeof hostShellInput>): Promise<HostShellActionResult> {
    const maxBytes =
      this.config.unsafeHostShell?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const timeoutMs = input.timeoutMs ?? this.config.unsafeHostShell?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
        detached: process.platform !== 'win32',
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      const append = (current: Buffer, chunk: Buffer) =>
        Buffer.concat([current, chunk]).subarray(0, maxBytes);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const kill = (signal: NodeJS.Signals) => {
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall through to killing the shell process.
          }
        }
        child.kill(signal);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 1000).unref();
      }, timeoutMs);
      timer.unref();
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ isError: true, text: error.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const out = stdout.toString('utf8');
        const err = stderr.toString('utf8');
        const result = {
          command: input.command,
          cwd: input.cwd,
          exitCode: code,
          signal,
          timedOut,
          stdout: out,
          stderr: err,
          stdoutTruncated: stdout.length >= maxBytes,
          stderrTruncated: stderr.length >= maxBytes,
        };
        resolve({
          isError: timedOut || code !== 0,
          text: JSON.stringify(result, null, 2),
        });
      });
    });
  }
}
