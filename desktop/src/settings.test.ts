import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings';
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
