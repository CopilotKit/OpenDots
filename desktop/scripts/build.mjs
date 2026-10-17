// Bundles the app's main process and preload script into dist/. Everything but
// Electron itself is bundled in, so the packaged app needs no node_modules.
import { build } from 'esbuild';

const signed = process.env.PLOOP_SIGNED === '1';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  define: { __PLOOP_SIGNED__: JSON.stringify(signed) },
});

await build({
  ...shared,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
});
