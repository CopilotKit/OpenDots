import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(
  new URL('../bin/cli.js', import.meta.resolve('varlock')),
);
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // Varlock 1.21.1 telemetry can crash during shutdown on Windows Node 24.
  env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: 'true' },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  console.error('Could not start the project Varlock CLI. Run npm install.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
