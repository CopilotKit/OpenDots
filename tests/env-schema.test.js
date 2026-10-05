import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'node_modules/varlock/bin/cli.js');
const fixtures = [];

afterEach(() => {
  for (const path of fixtures.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture(overrides = '') {
  const path = mkdtempSync(join(tmpdir(), 'opendots-env-test-'));
  fixtures.push(path);
  copyFileSync(join(root, '.env.schema'), join(path, '.env.schema'));
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  writeFileSync(join(path, '.env'), `${example}\n${overrides}\n`);
  return path;
}

function run(path, args = ['load', '--format', 'json'], entrypoint = cli) {
  // Keep host credentials and the repository's real .env out of the subprocess.
  const env = { VARLOCK_TELEMETRY_DISABLED: 'true' };
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: path,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
}

it('loads the credential-free template using the installed Varlock schema parser', () => {
  const result = run(fixture());
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
});

it('starts through the project wrapper, propagates child failures, and validates before running', () => {
  const wrapper = join(root, 'scripts/varlock.mjs');
  const failure = run(
    fixture(),
    ['run', '--', process.execPath, '-e', 'process.exit(17)'],
    wrapper,
  );
  expect(failure.error).toBeUndefined();
  expect(failure.status).toBe(17);
  expect(failure.stderr).not.toContain('UV_HANDLE_CLOSING');
  const invalid = run(
    fixture('MODEL_PROVIDER=invalid-provider'),
    ['run', '--', process.execPath, '-e', 'console.log("fixture-command-ran")'],
    wrapper,
  );
  expect(invalid.error).toBeUndefined();
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr + invalid.stdout).toContain('MODEL_PROVIDER');
  expect(invalid.stderr + invalid.stdout).not.toContain('fixture-command-ran');
});

it.each([
  ['MODEL_PROVIDER', 'unknown-provider'],
  ['CLAUDE_AUTH_MODE', 'api-key'],
  ['CODEX_AUTH_MODE', 'api-key'],
  ['CLAUDE_PERMISSION_MODE', 'invalid-permission'],
  ['CLAUDE_PERMISSION_MODE', 'dontAsk'],
  ['PORT', 'not-a-number'],
  ['ANTHROPIC_BASE_URL', 'not-a-url'],
])('rejects invalid %s before startup', (key, value) => {
  const result = run(fixture(`${key}=${value}`));
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain(key);
});

it('loads optional endpoints, local CLI settings, and deployment overrides', () => {
  const result = run(
    fixture(`
APP_ORIGIN=https://opendots.example
INTELLIGENCE_API_URL=https://intelligence.example
INTELLIGENCE_WS_URL=wss://intelligence.example
MODEL_PROVIDER=claude-subscription
CLAUDE_CWD=fixtures/workspace
CLAUDE_PERMISSION_MODE=plan
CODEX_CWD=fixtures/codex-workspace
SLACK_DOT_ID=fixture-dot
COMPUTER_MEMORY_BYTES=1073741824
COMPUTER_RUNTIME=runsc
ENGINE_SOCKET=/run/docker.sock`),
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
});

it('redacts sensitive logs and blocks secret responses while allowing public responses', () => {
  const sensitiveKeys = [
    'OWNER_TOKEN',
    'INTELLIGENCE_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CLINE_API_KEY',
    'BROWSER_SECRET',
    'VOICE_API_KEY',
    'COMPUTER_SUPERVISOR_TOKEN',
    'COMPUTER_TOKEN',
    'PARALLEL_API_KEY',
  ];
  const secrets = sensitiveKeys.map(
    (key) => `opendots-fixture-secret-${key.toLowerCase()}`,
  );
  const path = fixture(
    sensitiveKeys.map((key, index) => `${key}=${secrets[index]}`).join('\n'),
  );
  const script = join(path, 'protection-check.mjs');
  writeFileSync(
    script,
    `
console.log('public-response', await new Response('public fixture').text());
for (const key of ${JSON.stringify(sensitiveKeys)}) {
  console.log('secret-log', process.env[key]);
  try {
    new Response(process.env[key]);
    console.log('leak-was-allowed', key);
  } catch {
    console.log('leak-was-blocked', key);
  }
}
`,
  );
  const autoLoad = pathToFileURL(
    join(root, 'node_modules/varlock/dist/auto-load.mjs'),
  ).href;
  const result = run(path, [
    'run',
    '--',
    process.execPath,
    '--import',
    autoLoad,
    script,
  ]);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const output = result.stderr + result.stdout;
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output).toContain('public-response public fixture');
  for (const key of sensitiveKeys)
    expect(output).toContain(`leak-was-blocked ${key}`);
  expect(output).not.toContain('leak-was-allowed');
});
