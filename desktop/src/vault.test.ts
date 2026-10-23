import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultUnreadableError } from './encrypted-file';
import { createTestBox } from './test-box';
import { InvalidLoginError, Vault } from './vault';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ploop-vault-'));
  file = path.join(dir, 'vault.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const github = {
  url: 'https://github.com/login',
  username: 'ephraim',
  password: 'correct horse battery staple',
};

describe('Vault', () => {
  it('starts empty and lists logins without their passwords', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    expect(await vault.list()).toEqual([]);

    const saved = await vault.add(github);
    expect(saved).toMatchObject({
      label: 'github.com',
      username: 'ephraim',
      agentAccess: true,
    });
    expect(JSON.stringify(await vault.list())).not.toContain(github.password);
    expect((await vault.get(saved.id))?.password).toBe(github.password);
  });

  it('keeps nothing readable on disk and locks the file down', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    await vault.add({ ...github, notes: 'work account' });

    const onDisk = await readFile(file, 'utf8');
    for (const secret of [
      'github',
      'ephraim',
      github.password,
      'work account',
    ]) {
      expect(onDisk).not.toContain(secret);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('persists across instances that share a key', async () => {
    const box = createTestBox();
    await new Vault({ file, box }).add(github);
    expect(await new Vault({ file, box }).list()).toHaveLength(1);
  });

  it('refuses to open, and never overwrites, a vault it cannot decrypt', async () => {
    await new Vault({ file, box: createTestBox() }).add(github);
    const before = await readFile(file, 'utf8');

    const other = new Vault({ file, box: createTestBox() });
    await expect(other.list()).rejects.toBeInstanceOf(VaultUnreadableError);
    await expect(
      other.add({ ...github, username: 'someone-else' }),
    ).rejects.toBeInstanceOf(VaultUnreadableError);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('refuses a damaged file instead of treating it as empty', async () => {
    await writeFile(file, 'not json');
    const vault = new Vault({ file, box: createTestBox() });
    await expect(vault.add(github)).rejects.toBeInstanceOf(
      VaultUnreadableError,
    );
    expect(await readFile(file, 'utf8')).toBe('not json');
  });

  it('rejects addresses it would not sign in to', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    for (const url of [
      'http://example.com/login',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'not a url',
    ]) {
      await expect(vault.add({ ...github, url })).rejects.toBeInstanceOf(
        InvalidLoginError,
      );
    }
    await expect(
      vault.add({ ...github, url: 'http://localhost:3000/login' }),
    ).resolves.toBeDefined();
  });

  it('requires a username and a password', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    await expect(
      vault.add({ ...github, username: '  ' }),
    ).rejects.toBeInstanceOf(InvalidLoginError);
    await expect(vault.add({ ...github, password: '' })).rejects.toBeInstanceOf(
      InvalidLoginError,
    );
  });

  it('rejects a second login for the same site and username', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    await vault.add(github);
    await expect(
      vault.add({
        ...github,
        username: 'EPHRAIM',
        url: 'https://github.com/session',
      }),
    ).rejects.toThrow(/already saved/);
    await expect(
      vault.add({ ...github, username: 'someone-else' }),
    ).resolves.toBeDefined();
  });

  it('updates fields and keeps the saved password when the new one is blank', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    const { id } = await vault.add(github);

    await vault.update(id, {
      label: 'Work GitHub',
      password: '',
      agentAccess: false,
    });
    expect(await vault.get(id)).toMatchObject({
      label: 'Work GitHub',
      password: github.password,
      agentAccess: false,
    });

    await vault.update(id, { password: 'new password' });
    expect((await vault.get(id))?.password).toBe('new password');
  });

  it('removes a login', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    const { id } = await vault.add(github);
    expect(await vault.remove(id)).toBe(true);
    expect(await vault.remove(id)).toBe(false);
    expect(await vault.list()).toEqual([]);
  });

  it('does not lose logins added at the same time', async () => {
    const vault = new Vault({ file, box: createTestBox() });
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(name =>
        vault.add({ ...github, username: name }),
      ),
    );
    expect(await vault.list()).toHaveLength(5);
  });
});
