// Builds ploop's server and web app (the repository root) and copies them, with
// their production dependencies, into build-server/, which the after-pack hook
// puts inside the packaged app. Then starts the copy to prove it runs before
// anything is packaged.
import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootCheck } from './boot-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '..');
const out = path.join(desktop, 'build-server');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });

await rm(out, { recursive: true, force: true });
await cp(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) {
  await cp(path.join(root, file), path.join(out, file));
}
// The server has no native modules, so these work under Electron's Node too.
// Install scripts are skipped: none of them is needed to run it.
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: out,
  stdio: 'inherit',
});

await bootCheck(out);

console.log(`Prepared ${out}`);
