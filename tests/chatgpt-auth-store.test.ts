import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ChatGPTAuth } from '../src/server/chatgpt-auth.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

it('keeps a stable host ID in an atomically written credential file', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  const first = await ChatGPTAuth.open(path);
  const hostId = JSON.parse(await readFile(path, 'utf8')).extAgentHostId;
  const second = await ChatGPTAuth.open(path);
  expect(second).toBeDefined();
  expect(JSON.parse(await readFile(path, 'utf8')).extAgentHostId).toBe(hostId);
  if (process.platform !== 'win32')
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(first.status().connected).toBe(false);
});

it('quarantines a corrupt credential file without exposing its contents', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  await writeFile(path, 'truncated-private-token-data');
  const service = await ChatGPTAuth.open(path);
  expect(service.status().connected).toBe(false);
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  await expect(readdir(directory)).resolves.toHaveLength(2);
});
