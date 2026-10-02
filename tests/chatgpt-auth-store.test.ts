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
import { get } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatGPTAuth } from '../src/server/chatgpt-auth.js';

let directory = '';
const services: ChatGPTAuth[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.cancel());
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

it('keeps a stable host ID in an atomically written credential file', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  const first = await ChatGPTAuth.open(path);
  services.push(first);
  const hostId = JSON.parse(await readFile(path, 'utf8')).extAgentHostId;
  const second = await ChatGPTAuth.open(path);
  services.push(second);
  expect(second).toBeDefined();
  expect(JSON.parse(await readFile(path, 'utf8')).extAgentHostId).toBe(hostId);
  if (process.platform !== 'win32')
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(first.status().connected).toBe(false);
});

it('migrates an unregistered bare UUID host ID to the supported UUID URN', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  await writeFile(
    path,
    JSON.stringify({ version: 1, extAgentHostId: id, profiles: {} }),
    { mode: 0o600 },
  );
  const service = await ChatGPTAuth.open(path);
  services.push(service);
  expect(JSON.parse(await readFile(path, 'utf8')).extAgentHostId).toBe(
    `urn:uuid:${id}`,
  );
});

it('refuses to migrate a bare UUID after dynamic registration has been issued', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      extAgentHostId: '123e4567-e89b-42d3-a456-426614174000',
      issuedClientId: 'oaiapp_issued',
      profiles: {},
    }),
    { mode: 0o600 },
  );
  await expect(ChatGPTAuth.open(path)).rejects.toThrow(/Re-register/);
  expect(await readFile(path, 'utf8')).toContain('oaiapp_issued');
});

it('builds the required OAuth authorization URL and does not expose persisted tokens', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  const service = await ChatGPTAuth.open(path, { callbackPort: 0 });
  services.push(service);
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    Response.json({
      issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
    }),
  );
  const authorization = new URL(await service.start());
  expect(authorization.searchParams.get('client_id')).toBe(
    'dynamic_agent_client',
  );
  expect(authorization.searchParams.get('response_type')).toBe('code');
  expect(authorization.searchParams.get('resource')).toBe(
    'https://api.openai.com/v1',
  );
  expect(authorization.searchParams.get('scope')).toBe(
    'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  );
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization.searchParams.get('code_challenge')).toMatch(
    /^[A-Za-z0-9_-]{43}$/,
  );
  expect(authorization.searchParams.get('nonce')).toBeTruthy();
  expect(authorization.searchParams.get('state')).toBeTruthy();
  expect(authorization.searchParams.get('agent_name_hint')).toBe('OpenDots');
  expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(
    /^urn:uuid:[0-9a-f-]{36}$/,
  );
  expect(authorization.searchParams.has('access_token')).toBe(false);
  expect(authorization.searchParams.has('refresh_token')).toBe(false);
  expect(authorization.searchParams.has('id_token')).toBe(false);
  expect(authorization.searchParams.has('id_token_hint')).toBe(false);
});

it('does not consume a pending OAuth attempt when callback state is wrong', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const service = await ChatGPTAuth.open(join(directory, 'chatgpt-auth.json'), {
    callbackPort: 0,
  });
  services.push(service);
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    Response.json({
      issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
    }),
  );
  const authorization = new URL(await service.start());
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  const status = await new Promise<number>((resolve, reject) => {
    get(
      `${redirect.origin}${redirect.pathname}?state=wrong&code=not-used&client_id=oaiapp_fake`,
      { headers: { Host: redirect.host } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    ).on('error', reject);
  });
  expect(status).toBe(400);
  expect(service.status().connected).toBe(false);
  service.cancel();
});

it('rejects duplicate OAuth callback parameters without consuming the pending attempt', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const service = await ChatGPTAuth.open(join(directory, 'chatgpt-auth.json'), {
    callbackPort: 0,
  });
  services.push(service);
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    Response.json({
      issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
    }),
  );
  const authorization = new URL(await service.start());
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  const state = authorization.searchParams.get('state')!;
  const paths = [
    `${redirect.pathname}?state=${state}&state=${state}&code=x&client_id=oaiapp_x`,
    `${redirect.pathname}?state=${state}&code=x&code=y&client_id=oaiapp_x`,
    `${redirect.pathname}?state=${state}&code=x&client_id=oaiapp_x&client_id=oaiapp_x`,
  ];
  for (const path of paths) {
    const status = await new Promise<number>((resolve, reject) => {
      get(
        `${redirect.origin}${path}`,
        { headers: { Host: redirect.host } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      ).on('error', reject);
    });
    expect(status).toBe(400);
  }
  expect(
    fetchMock.mock.calls.every(
      ([input]) => !String(input).includes('/oauth/token'),
    ),
  ).toBe(true);
  expect(service.status().connected).toBe(false);
  service.cancel();
});

it.skipIf(process.platform === 'win32')(
  'refuses a symlinked credential path without reading or overwriting its target',
  async () => {
    directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
    const path = join(directory, 'chatgpt-auth.json');
    const outside = join(directory, 'outside-secret.json');
    await writeFile(outside, 'keep-this-secret-file');
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, path);
    await expect(ChatGPTAuth.open(path)).rejects.toThrow(/Could not read/);
    expect(await readFile(outside, 'utf8')).toBe('keep-this-secret-file');
  },
);

it('quarantines a corrupt credential file without exposing its contents', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  const path = join(directory, 'chatgpt-auth.json');
  await writeFile(path, 'truncated-private-token-data', { mode: 0o600 });
  const service = await ChatGPTAuth.open(path);
  expect(service.status().connected).toBe(false);
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  await expect(readdir(directory)).resolves.toHaveLength(2);
});
