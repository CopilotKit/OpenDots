import { generateKeyPairSync } from 'node:crypto';
import { get } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { ChatGPTAuth } from '../src/server/chatgpt-auth.js';

let directory = '';
const services: ChatGPTAuth[] = [];
const { privateKey: signingKey, publicKey: verificationKey } =
  generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongSigningKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey;
const signingJwk = exportJWK(verificationKey);
afterEach(async () => {
  services.splice(0).forEach((service) => service.cancel());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

async function callback(url: URL, params: Record<string, string>) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params))
    target.searchParams.set(key, value);
  return new Promise<number>((resolve, reject) => {
    get(target, { headers: { Host: target.host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });
}

async function setupAuth(
  subject = 'account-1',
  grantedScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
) {
  directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-flow-'));
  const auth = await ChatGPTAuth.open(join(directory, 'chatgpt-auth.json'), {
    callbackPort: 0,
  });
  services.push(auth);
  const jwk = {
    ...(await signingJwk),
    kid: 'auth-key',
    use: 'sig',
    alg: 'RS256',
  };
  let currentNonce = '';
  let currentSubject = subject;
  let failNextExchange = false;
  let claimsOverride: {
    issuer?: string;
    audience?: string | readonly string[];
    nonce?: string;
    azp?: string;
    issuedAt?: number;
    wrongSignature?: boolean;
  } = {};
  let modelCatalog = [
    { slug: 'model-first', display_name: 'Model First', visibility: 'list' },
  ];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration'))
        return Response.json({
          issuer: 'https://auth.openai.com',
          authorization_endpoint:
            'https://auth.openai.com/api/accounts/authorize',
          token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint:
            'https://auth.openai.com/api/accounts/oauth/revoke',
        });
      if (url.endsWith('/.well-known/jwks.json'))
        return Response.json({ keys: [jwk] });
      if (url.endsWith('/api/accounts/oauth/revoke'))
        return new Response(null, { status: 200 });
      if (url.endsWith('/api/accounts/oauth/token')) {
        if (failNextExchange) {
          failNextExchange = false;
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        const clientId =
          new URLSearchParams(init?.body as URLSearchParams).get('client_id') ??
          'oaiapp_test';
        const {
          issuer: tokenIssuer,
          audience,
          nonce,
          azp,
          issuedAt,
          wrongSignature,
        } = claimsOverride;
        const tokenAudience =
          typeof audience === 'string' || audience === undefined
            ? (audience ?? clientId)
            : [...audience];
        const idToken = await new SignJWT({
          nonce: nonce ?? currentNonce,
          email: 'owner@example.com',
          name: 'OpenDots Owner',
          ...(azp ? { azp } : {}),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'auth-key' })
          .setIssuer(tokenIssuer ?? 'https://auth.openai.com')
          .setAudience(tokenAudience)
          .setSubject(currentSubject)
          .setIssuedAt(issuedAt)
          .setExpirationTime('5m')
          .sign(wrongSignature ? wrongSigningKey : signingKey);
        return Response.json({
          access_token: 'access-fixture',
          refresh_token: 'refresh-fixture',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: grantedScopes,
        });
      }
      if (url.endsWith('/v1/models'))
        return Response.json({ models: modelCatalog });
      throw new Error(`Unexpected fetch URL ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const signIn = async () => {
    const authorization = new URL(await auth.start());
    currentNonce = authorization.searchParams.get('nonce')!;
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
    const status = await callback(redirect, {
      state: authorization.searchParams.get('state')!,
      code: 'single-use-code',
      client_id: 'oaiapp_test',
    });
    return { status, authorization, fetchMock };
  };
  return {
    auth,
    signIn,
    setSubject: (value: string) => {
      currentSubject = value;
    },
    setModels: (value: typeof modelCatalog) => {
      modelCatalog = value;
    },
    setClaims: (value: typeof claimsOverride) => {
      claimsOverride = value;
    },
    failNextExchange: () => {
      failNextExchange = true;
    },
  };
}

it('completes dynamic registration with a verified ID token and a usable plan profile', async () => {
  const { auth, signIn } = await setupAuth();
  const { status, authorization, fetchMock } = await signIn();
  expect(status).toBe(200);
  expect(authorization.searchParams.get('client_id')).toBe(
    'dynamic_agent_client',
  );
  expect(auth.status()).toMatchObject({
    connected: true,
    sharing: true,
    usable: true,
    model: 'model-first',
    email: 'owner@example.com',
  });
  const saved = JSON.parse(
    await readFile(join(directory, 'chatgpt-auth.json'), 'utf8'),
  );
  expect(saved.extAgentHostId).toMatch(/^urn:uuid:/);
  expect(saved.issuedClientId).toBeUndefined();
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/accounts/oauth/token'),
    ),
  ).toBe(true);
  await expect(
    callback(new URL(authorization.searchParams.get('redirect_uri')!), {
      state: authorization.searchParams.get('state')!,
      code: 'single-use-code',
      client_id: 'oaiapp_test',
    }),
  ).rejects.toThrow();
});

it.each([
  ['signature', { wrongSignature: true }],
  ['issuer', { issuer: 'https://invalid.example' }],
  ['audience', { audience: 'different-client' }],
  ['nonce', { nonce: 'wrong-nonce' }],
  ['issued-at time', { issuedAt: Math.floor(Date.now() / 1000) + 3600 }],
  [
    'azp with multiple audiences',
    { audience: ['oaiapp_test', 'other-client'], azp: 'wrong-client' },
  ],
] as const)(
  'rejects an ID token with an invalid %s',
  async (_label, claims) => {
    const { auth, signIn, setClaims } = await setupAuth();
    setClaims(claims);
    expect((await signIn()).status).toBe(400);
    expect(auth.status().connected).toBe(false);
  },
);

it('retains the original profile when reauthorization returns a different subject', async () => {
  const { auth, signIn, setSubject } = await setupAuth();
  const first = await signIn();
  expect(first.status).toBe(200);
  setSubject('different-account');
  const second = await signIn();
  expect(second.authorization.searchParams.get('client_id')).toBe(
    'oaiapp_test',
  );
  expect(second.authorization.searchParams.has('id_token_hint')).toBe(false);
  expect(second.status).toBe(400);
  expect(auth.status()).toMatchObject({
    connected: true,
    usable: true,
    model: 'model-first',
  });
});

it('persists a newly issued client ID before the one-time code exchange', async () => {
  const { auth, signIn, failNextExchange } = await setupAuth();
  failNextExchange();
  expect((await signIn()).status).toBe(400);
  expect(
    JSON.parse(await readFile(join(directory, 'chatgpt-auth.json'), 'utf8'))
      .issuedClientId,
  ).toBe('oaiapp_test');
  const retry = new URL(await auth.start());
  expect(retry.searchParams.get('client_id')).toBe('oaiapp_test');
  expect(retry.searchParams.has('agent_name_hint')).toBe(false);
});

it('keeps identity connected without plan permission and offers explicit re-consent', async () => {
  const { auth, signIn } = await setupAuth(
    'account-1',
    'openid profile email offline_access',
  );
  const { status } = await signIn();
  expect(status).toBe(200);
  expect(auth.status()).toMatchObject({
    connected: true,
    sharing: false,
    usable: false,
    needsReconsent: true,
  });
  expect(auth.provider()).toBe('openai-compatible');
  expect(auth.status().model).toBeUndefined();
  const authorization = new URL(await auth.start({ reconsent: true }));
  expect(authorization.searchParams.get('client_id')).toBe('oaiapp_test');
  expect(authorization.searchParams.get('prompt')).toBe('consent');
  expect(authorization.searchParams.get('scope')).toContain(
    'chatgpt.tokens.use.direct',
  );
  expect(authorization.searchParams.has('id_token_hint')).toBe(false);
});

it('disconnects local tokens but retains registration and verified account metadata', async () => {
  const { auth, signIn } = await setupAuth();
  expect((await signIn()).status).toBe(200);
  const savedBefore = JSON.parse(
    await readFile(join(directory, 'chatgpt-auth.json'), 'utf8'),
  );
  expect(await auth.disconnect()).toBe(true);
  const saved = JSON.parse(
    await readFile(join(directory, 'chatgpt-auth.json'), 'utf8'),
  );
  const retained = saved.profiles.oaiapp_test;
  expect(retained).toMatchObject({
    clientId: 'oaiapp_test',
    subject: 'account-1',
    email: 'owner@example.com',
  });
  expect(retained).not.toHaveProperty('accessToken');
  expect(retained).not.toHaveProperty('refreshToken');
  expect(retained).not.toHaveProperty('idToken');
  expect(saved.issuedClientId).toBe('oaiapp_test');
  expect(saved.extAgentHostId).toBe(savedBefore.extAgentHostId);
  const reauthorization = new URL(await auth.start());
  expect(reauthorization.searchParams.get('client_id')).toBe('oaiapp_test');
  expect(reauthorization.searchParams.has('id_token_hint')).toBe(false);
});

it('updates a disappeared selected model to the first visible account model', async () => {
  const { auth, signIn, setModels } = await setupAuth();
  expect((await signIn()).status).toBe(200);
  setModels([
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
    { slug: 'model-second', display_name: 'Model Second', visibility: 'list' },
  ]);
  await expect(auth.models()).resolves.toEqual([
    { slug: 'model-second', displayName: 'Model Second' },
  ]);
  expect(auth.status().model).toBe('model-second');
});
