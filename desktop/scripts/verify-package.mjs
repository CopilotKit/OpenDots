// Boots the server that electron-builder put inside the packaged app, with the
// app's own Electron runtime, so a package that is missing files fails the
// build instead of failing on a Mac.
// Usage: node scripts/verify-package.mjs release/mac-arm64/ploop.app
import path from 'node:path';
import { bootCheck } from './boot-check.mjs';

const app = process.argv[2];
if (app == null) throw new Error('Pass the path of the packaged .app.');
const contents = path.join(app, 'Contents');
const name = path.basename(app, '.app');
await bootCheck(
  path.join(contents, 'Resources', 'server'),
  path.join(contents, 'MacOS', name),
);
console.log(`Packaged server in ${app} starts and serves its files.`);
