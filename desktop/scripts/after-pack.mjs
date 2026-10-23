// Copies ploop's server into the app after electron-builder has packed it.
// electron-builder's extraResources copy silently drops every folder named
// node_modules, so the server is copied here instead and then checked for
// links that point nowhere before the app is signed.
import { cp, lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', 'build-server');

export async function findDanglingLinks(dir, found = []) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      try {
        await stat(full);
      } catch {
        found.push(full);
      }
    } else if (info.isDirectory()) {
      await findDanglingLinks(full, found);
    }
  }
  return found;
}

export default async function afterPack(context) {
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const target = path.join(resources, 'server');
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  const dangling = await findDanglingLinks(target);
  if (dangling.length > 0) {
    throw new Error(`Links that point nowhere in the packaged server:\n${dangling.join('\n')}`);
  }
}
