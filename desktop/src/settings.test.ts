import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { intelligenceFromEnvFile, SettingsStore } from './settings';
import { createTestBox } from './test-box';

let dir: string;
let store: SettingsStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ploop-settings-'));
  store = new SettingsStore({
    file: path.join(dir, 'settings.json'),
    box: createTestBox(),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('linked computer', () => {
  it('hands the SSH details to the server as environment variables', async () => {
    await store.save({
      openrouterApiKey: 'sk-or-test',
      sshHost: 'vm.example.com',
      sshUser: 'ubuntu',
      sshPort: '2222',
      sshKeyPath: '/Users/me/.ssh/id_ed25519',
    });

    expect(await store.toEnv()).toEqual({
      OPENROUTER_API_KEY: 'sk-or-test',
      PLOOP_SSH_HOST: 'vm.example.com',
      PLOOP_SSH_USER: 'ubuntu',
      PLOOP_SSH_PORT: '2222',
      PLOOP_SSH_KEY_PATH: '/Users/me/.ssh/id_ed25519',
    });
    expect(await store.status()).toMatchObject({
      sshHost: 'vm.example.com',
      sshUser: 'ubuntu',
    });
  });

  it('passes nothing on once the computer is unlinked', async () => {
    await store.save({ sshHost: 'vm.example.com', sshUser: 'ubuntu' });
    await store.save({ sshHost: '', sshUser: '' });

    expect(await store.toEnv()).toEqual({});
  });

  it('ignores a username or port without an address', async () => {
    await store.save({ sshUser: 'ubuntu', sshPort: '2222' });

    expect(await store.toEnv()).toEqual({});
  });
});

describe('keys', () => {
  it('hands the model and Intelligence keys to the server, never in the status', async () => {
    await store.save({
      openrouterApiKey: 'sk-or-test',
      intelligenceApiKey: 'cpk-test',
      model: 'openai/gpt-5',
    });

    expect(await store.toEnv()).toEqual({
      OPENROUTER_API_KEY: 'sk-or-test',
      CPK_INTELLIGENCE_API_KEY: 'cpk-test',
      PLOOP_MODEL: 'openai/gpt-5',
    });
    const status = await store.status();
    expect(status).toMatchObject({
      openrouterApiKey: true,
      intelligenceApiKey: true,
      model: 'openai/gpt-5',
    });
    expect(JSON.stringify(status)).not.toContain('cpk-test');
  });

  it('keeps one owner token across launches', async () => {
    const first = await store.ownerToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.ownerToken()).toBe(first);
    expect(await store.toEnv()).toEqual({});
  });
});

describe('Intelligence from the CLI', () => {
  it('reads a hosted project from what `project select` writes', () => {
    expect(
      intelligenceFromEnvFile(
        [
          '# OpenDots template',
          'OPENAI_API_KEY=sk-not-for-us',
          'CPK_INTELLIGENCE_API_KEY="cpk-hosted"',
          'CPK_TELEMETRY_ID=tel-123 # keep with the key',
        ].join('\n'),
      ),
    ).toEqual({
      intelligenceApiKey: 'cpk-hosted',
      intelligenceApiUrl: '',
      intelligenceWsUrl: '',
      telemetryId: 'tel-123',
    });
  });

  it('reads Intelligence on this Mac from what `local connect` writes', () => {
    expect(
      intelligenceFromEnvFile(
        [
          'INTELLIGENCE_API_KEY=cpk-local',
          'INTELLIGENCE_API_URL=http://localhost:4201',
          "export INTELLIGENCE_GATEWAY_WS_URL='ws://localhost:4401'",
        ].join('\r\n'),
      ),
    ).toMatchObject({
      intelligenceApiKey: 'cpk-local',
      intelligenceApiUrl: 'http://localhost:4201',
      intelligenceWsUrl: 'ws://localhost:4401',
    });
  });

  it('refuses a file without a key', () => {
    expect(() => intelligenceFromEnvFile('OPENAI_API_KEY=sk')).toThrow(
      /no Intelligence key/,
    );
  });

  it('hands a local connection to the server and drops it again for hosted', async () => {
    await store.save({
      intelligenceApiKey: 'cpk-local',
      intelligenceApiUrl: 'http://localhost:4201',
      intelligenceWsUrl: 'ws://localhost:4401',
    });
    expect(await store.toEnv()).toEqual({
      CPK_INTELLIGENCE_API_KEY: 'cpk-local',
      INTELLIGENCE_API_URL: 'http://localhost:4201',
      INTELLIGENCE_GATEWAY_WS_URL: 'ws://localhost:4401',
    });

    await store.save(
      intelligenceFromEnvFile(
        'CPK_INTELLIGENCE_API_KEY=cpk-hosted\nCPK_TELEMETRY_ID=tel-1',
      ),
    );
    expect(await store.toEnv()).toEqual({
      CPK_INTELLIGENCE_API_KEY: 'cpk-hosted',
      CPK_TELEMETRY_ID: 'tel-1',
    });
  });
});
