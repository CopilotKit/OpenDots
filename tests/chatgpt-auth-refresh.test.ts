import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { ChatGPTAuth } from '../src/server/chatgpt-auth.js';

let directory = '';
const services: ChatGPTAuth[] = [];
const hostId = 'urn:uuid:123e4567-e89b-42d3-a456-426614174000';
afterEach(async () => {
  services.splice(0).forEach((service) => service.cancel());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

async function seedProfile(overrides: Record<string, unknown> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-refresh-'));
  const path = join(directory, 'chatgpt-auth.json');
  const profile = {
    clientId: 'oaiapp_refresh',
    subject: 'account-1',
    email: 'owner@example.com',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    idToken: 'retained-id-token',
    scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
    expiresAt: Date.now() - 1000,
    model: 'listed-model',
    ...overrides,
  };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      extAgentHostId: hostId,
      activeClientId: profile.clientId,
      modelProvider: 'chatgpt-plan',
      profiles: { [profile.clientId]: profile },
    }),
    { mode: 0o600 },
  );
  const auth = await ChatGPTAuth.open(path);
  services.push(auth);
  return { auth, path };
}

function openIdConfig() {
  return Response.json({
    issuer: 'https://auth.openai.com',
    authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
    token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
  });
}

it.each([
  ['numeric epoch seconds', () => Math.floor((Date.now() + 60_000) / 1000)],
  ['parseable date string', () => new Date(Date.now() + 60_000).toISOString()],
] as const)(
  'returns a still-valid access token when earliest_refresh_at is a future %s',
  async (_label, earliest) => {
    const { auth } = await seedProfile({
      expiresAt: Date.now() + 30_000,
      earliestRefreshAt: earliest(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(auth.getValidAccessToken()).resolves.toBe('access-old');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  ['numeric epoch seconds', () => Math.floor((Date.now() + 60_000) / 1000)],
  ['parseable date string', () => new Date(Date.now() + 60_000).toISOString()],
] as const)(
  'returns refresh_not_ready without a long wait when the access token is expired and earliest_refresh_at is a future %s',
  async (_label, earliest) => {
    const { auth } = await seedProfile({
      expiresAt: Date.now() - 1000,
      earliestRefreshAt: earliest(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(auth.getValidAccessToken()).rejects.toThrow(/not ready yet/i);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('serializes concurrent refreshes and preserves prior scopes when the response omits scope', async () => {
  const { auth, path } = await seedProfile();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/.well-known/openid-configuration'))
      return openIdConfig();
    return Response.json({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 3600,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    Promise.all([auth.getValidAccessToken(), auth.getValidAccessToken()]),
  ).resolves.toEqual(['access-new', 'access-new']);
  expect(
    fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/oauth/token'),
    ),
  ).toHaveLength(1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.profiles.oaiapp_refresh).toMatchObject({
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
    scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
  });
});

it('checkpoints a rotated refresh token before ID-token verification and recovers it after restart', async () => {
  const { auth, path } = await seedProfile();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'refresh-key',
    use: 'sig',
    alg: 'RS256',
  };
  const idToken = await new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'refresh-key' })
    .setIssuer('https://auth.openai.com')
    .setAudience('oaiapp_refresh')
    .setSubject('account-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const initialFetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/.well-known/openid-configuration'))
      return openIdConfig();
    if (String(input).endsWith('/.well-known/jwks.json'))
      return Response.json(
        { detail: 'temporarily unavailable' },
        { status: 503 },
      );
    return Response.json({
      access_token: 'access-successor',
      refresh_token: 'refresh-successor',
      id_token: idToken,
      expires_in: 3600,
    });
  });
  vi.stubGlobal('fetch', initialFetch);
  await expect(auth.getValidAccessToken()).rejects.toThrow(
    /temporarily unavailable/i,
  );
  const checkpoint = JSON.parse(await readFile(path, 'utf8'));
  expect(checkpoint.profiles.oaiapp_refresh.pendingRefresh).toMatchObject({
    refreshToken: 'refresh-successor',
    accessToken: 'access-successor',
  });

  const restarted = await ChatGPTAuth.open(path);
  services.push(restarted);
  const recoveryFetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/.well-known/openid-configuration'))
      return openIdConfig();
    if (String(input).endsWith('/.well-known/jwks.json'))
      return Response.json({ keys: [jwk] });
    throw new Error('Recovery must not reuse a consumed refresh token.');
  });
  vi.stubGlobal('fetch', recoveryFetch);
  await expect(restarted.getValidAccessToken()).resolves.toBe(
    'access-successor',
  );
  expect(
    recoveryFetch.mock.calls.some(([input]) =>
      String(input).endsWith('/oauth/token'),
    ),
  ).toBe(false);
  const recovered = JSON.parse(await readFile(path, 'utf8'));
  expect(recovered.profiles.oaiapp_refresh).toMatchObject({
    refreshToken: 'refresh-successor',
    accessToken: 'access-successor',
  });
  expect(recovered.profiles.oaiapp_refresh.pendingRefresh).toBeUndefined();
});
