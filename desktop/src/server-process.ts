import { app, utilityProcess, type UtilityProcess } from 'electron';
import { createWriteStream, mkdirSync, statSync, truncateSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// Runs ploop's chat server (the Hono server and web app at the repository root)
// as a child process on a free port of this Mac, reachable only from this Mac.
export type RunningServer = {
  origin: string;
  port: number;
  // Resolves once the process has exited and its port is free again.
  stop(): Promise<void>;
  onExit(listener: () => void): void;
};

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function isUp(port: number) {
  return new Promise<boolean>(resolve => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 1500 },
      response => {
        response.resume();
        resolve(true);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitUntilUp(
  port: number,
  isAlive: () => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('ploop’s server stopped while starting.');
    if (await isUp(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('ploop’s server did not start in time.');
}

// Where the server is. Packaged builds carry it (built, with its production
// dependencies) in the app's resources; a dev run uses the repository root,
// after `npm run build` there. It serves the web app from ./dist/client, so it
// runs from that folder.
function serverDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.resolve(__dirname, '..', '..');
}

export async function startServer(options: {
  env: Record<string, string>;
  logFile: string;
  // Reuse a port (when restarting) so the window's origin stays the same.
  port?: number;
}): Promise<RunningServer> {
  const port = options.port ?? (await freePort());
  const dir = serverDir();

  mkdirSync(path.dirname(options.logFile), { recursive: true });
  try {
    if (statSync(options.logFile).size > 1_000_000)
      truncateSync(options.logFile);
  } catch {
    // No log yet.
  }
  const log = createWriteStream(options.logFile, { flags: 'a', mode: 0o600 });

  // Only what the server needs, so it never inherits the shell's variables.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_ENV: 'production',
    DO_NOT_TRACK: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    PLOOP_DESKTOP: '1',
    ...options.env,
  };

  let alive = true;
  const exitListeners: Array<() => void> = [];
  const child: UtilityProcess = utilityProcess.fork(
    path.join(dir, 'dist', 'server', 'server', 'index.js'),
    [],
    {
      cwd: dir,
      env,
      stdio: 'pipe',
      serviceName: 'ploop server',
    },
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('exit', () => {
    alive = false;
    log.end();
    for (const listener of exitListeners) listener();
  });

  await waitUntilUp(port, () => alive, 90_000);

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>(resolve => {
        if (!alive) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
    onExit: listener => exitListeners.push(listener),
  };
}
