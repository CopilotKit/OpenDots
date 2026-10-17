// Starts a built ploop server (the folder holding dist/ and node_modules/) the
// way the app does, and asks it for the web app and one of its files.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// `runtime` is the program to run it with: this Node by default, or the
// packaged app's own Electron binary, which then acts as Node.
export async function bootCheck(serverDir, runtime = process.execPath) {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const data = await mkdtemp(path.join(os.tmpdir(), 'ploop-boot-'));
  const server = spawn(runtime, [path.join('dist', 'server', 'server', 'index.js')], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      DO_NOT_TRACK: '1',
      OWNER_TOKEN: 'boot-check-owner-token-0123456789',
      DATABASE_PATH: path.join(data, 'ploop.sqlite'),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => (output += chunk));
  server.stderr.on('data', chunk => (output += chunk));

  try {
    const base = `http://127.0.0.1:${port}`;
    let page;
    for (let attempt = 0; attempt < 60 && page == null; attempt++) {
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) page = await response.text();
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (page == null) throw new Error(`The packaged server did not start:\n${output}`);

    const asset = page.match(/\/assets\/[^"']+\.(?:css|js)/)?.[0];
    if (asset == null || !(await fetch(`${base}${asset}`)).ok) {
      throw new Error(`The packaged server did not serve its files (${asset}).`);
    }
  } finally {
    server.kill();
    await rm(data, { recursive: true, force: true });
  }
}
