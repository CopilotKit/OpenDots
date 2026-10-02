import { createServer, type Server } from 'node:http';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, rename, open, lstat, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { z } from 'zod';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const MAX_CREDENTIAL_FILE_BYTES = 1_000_000;
async function assertSafeCredentialDirectory(path: string) {
  const directory = resolve(dirname(path));
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(
      'The ChatGPT credential directory must be a real directory.',
    );
  const actual = resolve(await realpath(directory));
  const same =
    process.platform === 'win32'
      ? actual.toLowerCase() === directory.toLowerCase()
      : actual === directory;
  if (!same)
    throw new Error(
      'The ChatGPT credential directory cannot resolve through a symbolic link.',
    );
}
const profileSchema = z.object({
  clientId: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  idToken: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  earliestRefreshAt: z.union([z.number(), z.string()]).optional(),
  model: z.string().optional(),
  pendingRefresh: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string(),
      idToken: z.string(),
      scopes: z.array(z.string()),
      expiresAt: z.number(),
      earliestRefreshAt: z.union([z.number(), z.string()]).optional(),
      receivedAt: z.number(),
    })
    .optional(),
});
const fileSchema = z
  .object({
    version: z.literal(1),
    extAgentHostId: z
      .string()
      .regex(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    activeClientId: z.string().optional(),
    issuedClientId: z.string().optional(),
    modelProvider: z.enum(['openai-compatible', 'chatgpt-plan']).optional(),
    profiles: z.record(z.string(), profileSchema),
  })
  .superRefine((file, context) => {
    if (file.activeClientId && !file.profiles[file.activeClientId])
      context.addIssue({
        code: 'custom',
        message: 'Active ChatGPT profile is missing.',
      });
    for (const [clientId, profile] of Object.entries(file.profiles))
      if (clientId !== profile.clientId)
        context.addIssue({
          code: 'custom',
          message: 'ChatGPT profile registration mismatch.',
        });
  });
type Profile = z.infer<typeof profileSchema>;
type AuthFile = z.infer<typeof fileSchema>;
let discoveryCache:
  | Promise<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      revocation_endpoint?: string;
    }>
  | undefined;
async function discovery() {
  discoveryCache ??= fetch(`${issuer}/.well-known/openid-configuration`)
    .then(async (response) => {
      const raw: unknown = await response.json();
      const parsed = z
        .object({
          issuer: z.literal(issuer),
          authorization_endpoint: z.string().url(),
          token_endpoint: z.string().url(),
          jwks_uri: z.string().url(),
          revocation_endpoint: z.string().url().optional(),
        })
        .parse(raw);
      for (const endpoint of [
        parsed.authorization_endpoint,
        parsed.token_endpoint,
        parsed.jwks_uri,
        parsed.revocation_endpoint,
      ].filter(Boolean))
        if (new URL(endpoint!).origin !== issuer)
          throw new Error('Invalid OpenID discovery endpoint.');
      if (!response.ok) throw new Error('OpenID discovery unavailable.');
      return parsed;
    })
    .catch((error) => {
      discoveryCache = undefined;
      throw error;
    });
  return discoveryCache;
}
async function verifyIdentityToken(
  token: string,
  clientId: string,
  nonce?: string,
  receivedAt?: number,
): Promise<JWTPayload> {
  let config: Awaited<ReturnType<typeof discovery>>;
  try {
    config = await discovery();
  } catch {
    throw new Error(
      'ChatGPT identity verification is temporarily unavailable. Your connection has been preserved. Try again shortly.',
    );
  }
  let unavailable = false;
  try {
    const jwks = createRemoteJWKSet(new URL(config.jwks_uri), {
      timeoutDuration: 15_000,
      [customFetch]: async (url, options) => {
        try {
          const response = await fetch(url, options);
          const value: unknown = await response.clone().json();
          if (
            !response.ok ||
            !value ||
            typeof value !== 'object' ||
            !Array.isArray((value as { keys?: unknown }).keys)
          )
            throw new Error('JWKS unavailable');
          return response;
        } catch {
          unavailable = true;
          throw new Error('JWKS unavailable');
        }
      },
    });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
      ...(receivedAt === undefined
        ? {}
        : { currentDate: new Date(receivedAt) }),
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.iat !== 'number' ||
      payload.iat > Date.now() / 1000 + 5 ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    )
      throw new Error('Invalid identity claims.');
    return payload;
  } catch {
    if (unavailable) {
      throw new Error(
        'ChatGPT identity verification is temporarily unavailable. Your connection has been preserved. Try again shortly.',
      );
    }
    throw new Error(
      'The ChatGPT identity could not be verified. Please sign in again.',
    );
  }
}

interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  previousSubject?: string;
  server: Server;
  consumed: boolean;
  expiresAt: number;
}

export class ChatGPTAuth {
  private data: AuthFile;
  private attempt?: Attempt;
  private refreshes = new Map<string, Promise<string>>();
  private constructor(
    private path: string,
    data: AuthFile,
    private callbackHost = '127.0.0.1',
    private callbackPort = 0,
  ) {
    this.data = data;
  }

  static async open(
    path: string,
    options?: { callbackHost?: string; callbackPort?: number },
  ): Promise<ChatGPTAuth> {
    let data: AuthFile = {
      version: 1,
      extAgentHostId: `urn:uuid:${randomUUID()}`,
      profiles: {},
    };
    let contents: string | undefined;
    try {
      await assertSafeCredentialDirectory(path);
      const metadata = await lstat(path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > MAX_CREDENTIAL_FILE_BYTES
      )
        throw new Error(
          'The ChatGPT credential file must be a regular file smaller than 1 MB.',
        );
      if (
        process.platform !== 'win32' &&
        ((metadata.mode & 0o077) !== 0 ||
          (process.getuid && metadata.uid !== process.getuid()))
      )
        throw new Error(
          'The ChatGPT credential file must be owned by this user and readable only by its owner.',
        );
      const file = await open(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        contents = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Could not read the ChatGPT credential file. Check its permissions.',
          { cause: error },
        );
    }
    let invalid = false;
    let migrationBlocked = false;
    if (contents !== undefined) {
      try {
        const parsed = JSON.parse(contents) as Record<string, unknown>;
        if (
          typeof parsed.extAgentHostId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            parsed.extAgentHostId,
          )
        ) {
          if (
            Object.keys((parsed.profiles as object) ?? {}).length ||
            parsed.issuedClientId
          ) {
            migrationBlocked = true;
            throw new Error(
              'A registered ChatGPT connection cannot change its host ID. Re-register the ChatGPT connection.',
            );
          }
          parsed.extAgentHostId = `urn:uuid:${parsed.extAgentHostId}`;
        }
        data = fileSchema.parse(parsed);
      } catch {
        invalid = true;
      }
    }
    if (migrationBlocked)
      throw new Error(
        'A registered ChatGPT connection cannot change its host ID. Re-register the ChatGPT connection.',
      );
    if (contents !== undefined && invalid) {
      try {
        await rename(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        throw new Error(
          'The ChatGPT credential file is invalid and could not be quarantined.',
        );
      }
    }
    const service = new ChatGPTAuth(
      path,
      data,
      options?.callbackHost,
      options?.callbackPort,
    );
    if (!data.profiles || !Object.keys(data.profiles).length)
      await service.save();
    return service;
  }

  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await assertSafeCredentialDirectory(this.path);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(this.data));
      await file.chmod(0o600);
      await file.sync();
      await file.close();
      await rename(temp, this.path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await import('node:fs/promises').then(({ unlink }) =>
        unlink(temp).catch(() => undefined),
      );
      throw new Error('Could not safely save ChatGPT credentials.', {
        cause: error,
      });
    }
  }

  status() {
    const p = this.data.activeClientId
      ? this.data.profiles[this.data.activeClientId]
      : undefined;
    return {
      connected: !!p,
      sharing: !!p?.scopes.includes('chatgpt.tokens.use.direct'),
      usable:
        !!p?.scopes.includes('chatgpt.tokens.use.direct') &&
        !!p?.refreshToken &&
        !!p?.model,
      email: p?.email,
      model:
        p?.scopes.includes('chatgpt.tokens.use.direct') && p?.refreshToken
          ? p.model
          : undefined,
      needsReconsent: !!p && !p.scopes.includes('chatgpt.tokens.use.direct'),
      name: p?.name,
      provider: 'chatgpt-plan' as const,
    };
  }
  provider() {
    return (
      this.data.modelProvider ??
      (this.status().usable ? 'chatgpt-plan' : 'openai-compatible')
    );
  }
  async setProvider(provider: 'openai-compatible' | 'chatgpt-plan') {
    this.data.modelProvider = provider;
    await this.save();
  }
  selectModel(model: string) {
    const p = this.active();
    if (!p) throw new Error('ChatGPT is not connected.');
    p.model = model;
    return this.save();
  }
  private active() {
    return this.data.activeClientId
      ? this.data.profiles[this.data.activeClientId]
      : undefined;
  }

  async start(options: { reconsent?: boolean } = {}): Promise<string> {
    if (this.attempt) {
      this.attempt.server.close();
      this.attempt = undefined;
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (url.pathname !== '/auth/callback' || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      const pending = this.attempt;
      if (
        !pending ||
        pending.server !== server ||
        pending.consumed ||
        Date.now() > pending.expiresAt
      ) {
        res
          .writeHead(410)
          .end('Sign-in expired. Return to OpenDots and try again.');
        return;
      }
      const expectedHost = new URL(pending.redirectUri).host;
      const states = url.searchParams.getAll('state');
      const left = Buffer.from(states[0] ?? '');
      const right = Buffer.from(pending.state);
      const stateMatches =
        left.length === right.length && timingSafeEqual(left, right);
      const codes = url.searchParams.getAll('code');
      const issuedIds = url.searchParams.getAll('client_id');
      const errors = url.searchParams.getAll('error');
      const dynamicClient = pending.clientId === 'dynamic_agent_client';
      const returnedClientValid = dynamicClient
        ? issuedIds.length === 1 &&
          /^[a-zA-Z0-9_-]{1,200}$/.test(issuedIds[0]) &&
          issuedIds[0] !== 'dynamic_agent_client'
        : issuedIds.length === 0 ||
          (issuedIds.length === 1 && issuedIds[0] === pending.clientId);
      if (
        req.headers.host !== expectedHost ||
        (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
      ) {
        res
          .writeHead(400)
          .end('Invalid callback host. Return to OpenDots and try again.');
        return;
      }
      if (
        states.length !== 1 ||
        !stateMatches ||
        codes.length > 1 ||
        issuedIds.length > 1 ||
        errors.length > 1 ||
        !returnedClientValid ||
        (errors.length ? codes.length !== 0 : codes.length !== 1)
      ) {
        res
          .writeHead(400)
          .end(
            'Invalid sign-in callback. Return to the browser tab that started sign-in.',
          );
        return;
      }
      pending.consumed = true;
      void this.finish(url, pending)
        .then(() => {
          res
            .writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            .end(
              '<!doctype html><title>Connected</title><p>ChatGPT connected. You can close this tab and return to OpenDots.</p>',
            );
        })
        .catch(() => {
          res
            .writeHead(400, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            .end(
              '<!doctype html><title>Sign-in failed</title><p>ChatGPT sign-in could not be completed. Return to OpenDots and try again.</p>',
            );
        })
        .finally(() => {
          if (this.attempt === pending) this.attempt = undefined;
          server.close();
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.callbackPort, this.callbackHost, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not start the local ChatGPT callback.');
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const current =
      this.active() ??
      (this.data.issuedClientId
        ? this.data.profiles[this.data.issuedClientId]
        : undefined);
    const clientId =
      current?.clientId ?? this.data.issuedClientId ?? 'dynamic_agent_client';
    const attempt: Attempt = {
      state,
      nonce,
      verifier,
      redirectUri,
      clientId,
      previousSubject: current?.subject,
      server,
      consumed: false,
      expiresAt: Date.now() + 10 * 60_000,
    };
    this.attempt = attempt;
    const expiry = setTimeout(() => {
      if (this.attempt === attempt) this.cancel();
    }, 10 * 60_000);
    expiry.unref();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL((await discovery()).authorization_endpoint);
    const params: Record<string, string> = {
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: this.data.extAgentHostId,
    };
    if (clientId === 'dynamic_agent_client')
      params.agent_name_hint = 'OpenDots';
    // Keep persisted tokens out of browser URLs and opener process arguments.
    if (current?.email) params.login_hint = current.email;
    if (options.reconsent) params.prompt = 'consent';
    for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);
    return auth.toString();
  }
  cancel() {
    this.attempt?.server.close();
    this.attempt = undefined;
  }

  private async finish(url: URL, a: Attempt) {
    const receivedState = url.searchParams.get('state') ?? '';
    const left = Buffer.from(receivedState);
    const right = Buffer.from(a.state);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw new Error('OAuth state validation failed.');
    if (url.searchParams.has('error'))
      throw new Error('ChatGPT authorization was not completed.');
    const code = url.searchParams.get('code');
    const issued = url.searchParams.get('client_id');
    const clientId =
      a.clientId === 'dynamic_agent_client' ? issued : a.clientId;
    if (
      !code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (a.clientId !== 'dynamic_agent_client' && issued && issued !== a.clientId)
    )
      throw new Error('ChatGPT registration was incomplete.');
    if (a.clientId === 'dynamic_agent_client') {
      this.data.issuedClientId = clientId;
      await this.save();
    }
    const response = await fetch((await discovery()).token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: a.verifier,
        redirect_uri: a.redirectUri,
        resource,
      }),
    });
    const raw: unknown = await response.json().catch(() => null);
    const token = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
        id_token: z.string().min(1),
        expires_in: z.number().positive(),
        scope: z.string(),
        earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
      })
      .safeParse(raw);
    if (!response.ok || !token.success)
      throw new Error('ChatGPT token exchange failed.');
    if (this.attempt !== a) throw new Error('ChatGPT sign-in was cancelled.');
    const payload = await verifyIdentityToken(
      token.data.id_token,
      clientId,
      a.nonce,
    );
    if (
      payload.nonce !== a.nonce ||
      typeof payload.sub !== 'string' ||
      !payload.sub
    )
      throw new Error('ChatGPT identity validation failed.');
    if (a.previousSubject && payload.sub !== a.previousSubject)
      throw new Error(
        'The signed-in ChatGPT account did not match the selected account.',
      );
    const granted = token.data.scope.split(/\s+/).filter(Boolean);
    if (this.attempt !== a) throw new Error('ChatGPT sign-in was cancelled.');
    const email =
      typeof payload.email === 'string' &&
      z.string().email().safeParse(payload.email).success
        ? payload.email
        : undefined;
    const p: Profile = {
      clientId,
      subject: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      idToken: token.data.id_token,
      accessToken: token.data.access_token,
      refreshToken: token.data.refresh_token,
      scopes: granted,
      expiresAt: Date.now() + token.data.expires_in * 1000,
      earliestRefreshAt: token.data.earliest_refresh_at,
    };
    if (!granted.includes('chatgpt.tokens.use.direct')) {
      // Keep the verified account connected; plan inference remains disabled until explicit re-consent.
      this.data.profiles[clientId] = p;
      this.data.activeClientId = clientId;
      this.data.issuedClientId = undefined;
      await this.save();
      return;
    }
    const previousProfile = this.data.profiles[clientId];
    const previousActive = this.data.activeClientId;
    const previousProvider = this.data.modelProvider;
    this.data.profiles[clientId] = p;
    this.data.activeClientId = clientId;
    let available: Awaited<ReturnType<ChatGPTAuth['models']>>;
    try {
      available = await this.models();
    } catch (error) {
      if (previousProfile) this.data.profiles[clientId] = previousProfile;
      else delete this.data.profiles[clientId];
      this.data.activeClientId = previousActive;
      this.data.modelProvider = previousProvider;
      throw error;
    }
    if (!available.length) {
      if (previousProfile) this.data.profiles[clientId] = previousProfile;
      else delete this.data.profiles[clientId];
      this.data.activeClientId = previousActive;
      this.data.modelProvider = previousProvider;
      throw new Error('No models are available to this ChatGPT account.');
    }
    p.model = available[0].slug;
    this.data.modelProvider = 'chatgpt-plan';
    this.data.issuedClientId = undefined;
    try {
      await this.save();
    } catch (error) {
      if (previousProfile) this.data.profiles[clientId] = previousProfile;
      else delete this.data.profiles[clientId];
      this.data.activeClientId = previousActive;
      this.data.modelProvider = previousProvider;
      if (a.clientId === 'dynamic_agent_client')
        this.data.issuedClientId = clientId;
      throw error;
    }
  }

  async getValidAccessToken(): Promise<string> {
    const p = this.active();
    if (!p || !p.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    if (p.accessToken && p.expiresAt > Date.now() + 120_000)
      return p.accessToken;
    const existing = this.refreshes.get(p.clientId);
    if (existing) return existing;
    const task = this.refresh(p);
    this.refreshes.set(p.clientId, task);
    try {
      return await task;
    } finally {
      this.refreshes.delete(p.clientId);
    }
  }
  private async refresh(p: Profile): Promise<string> {
    if (p.pendingRefresh) {
      const verified = await verifyIdentityToken(
        p.pendingRefresh.idToken,
        p.clientId,
        undefined,
        p.pendingRefresh.receivedAt,
      );
      if (verified.sub !== p.subject)
        throw new Error(
          'ChatGPT identity verification needs attention. Sign in again.',
        );
      Object.assign(p, p.pendingRefresh);
      delete p.pendingRefresh;
      await this.save();
      if (p.accessToken && p.expiresAt > Date.now()) return p.accessToken;
    }
    const earliest =
      typeof p.earliestRefreshAt === 'number'
        ? p.earliestRefreshAt * 1000
        : typeof p.earliestRefreshAt === 'string'
          ? Date.parse(p.earliestRefreshAt)
          : 0;
    if (earliest > Date.now()) {
      if (p.accessToken && p.expiresAt > Date.now()) return p.accessToken;
      throw new Error('ChatGPT token refresh is not ready yet. Retry shortly.');
    }
    if (!p.refreshToken)
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    const response = await fetch((await discovery()).token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: p.clientId,
        refresh_token: p.refreshToken,
        resource,
      }),
    });
    const raw: unknown = await response.json().catch(() => null);
    const result = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        id_token: z.string().min(1).optional(),
        expires_in: z.number().positive(),
        scope: z.string().optional(),
        earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
      })
      .safeParse(raw);
    if (!response.ok || !result.success)
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    const scopesNext = result.data.scope
      ? result.data.scope.split(/\s+/).filter(Boolean)
      : p.scopes;
    const next = {
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token ?? p.refreshToken ?? '',
      expiresAt: Date.now() + result.data.expires_in * 1000,
      earliestRefreshAt: result.data.earliest_refresh_at,
      scopes: scopesNext,
    };
    if (result.data.id_token) {
      const checkpoint = {
        ...next,
        idToken: result.data.id_token,
        receivedAt: Date.now(),
      };
      p.pendingRefresh = checkpoint;
      await this.save();
      const verified = await verifyIdentityToken(
        checkpoint.idToken,
        p.clientId,
        undefined,
        checkpoint.receivedAt,
      );
      if (verified.sub !== p.subject)
        throw new Error(
          'ChatGPT identity verification needs attention. Sign in again.',
        );
      p.idToken = checkpoint.idToken;
      delete p.pendingRefresh;
    }
    Object.assign(p, next);
    await this.save();
    if (!p.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    if (!p.accessToken)
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    return p.accessToken;
  }
  async models() {
    const token = await this.getValidAccessToken();
    const response = await fetch(`${resource}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error('Could not load models for this ChatGPT account.');
    const parsed = z
      .object({
        models: z.array(
          z.object({
            slug: z.string(),
            display_name: z.string(),
            visibility: z.string(),
          }),
        ),
      })
      .safeParse(raw);
    if (!parsed.success)
      throw new Error('OpenAI returned an invalid model catalog.');
    const models = parsed.data.models
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ slug: m.slug, displayName: m.display_name }));
    const profile = this.active();
    if (
      profile?.model &&
      models.length &&
      !models.some((model) => model.slug === profile.model)
    ) {
      profile.model = models[0].slug;
      await this.save();
    }
    return models;
  }
  async disconnect(): Promise<boolean> {
    const id = this.data.activeClientId;
    const p = this.active();
    if (!id || !p) return true;
    let revoked = false;
    try {
      const provider = await discovery();
      if (!provider.revocation_endpoint)
        throw new Error('No revocation endpoint.');
      const response = await fetch(provider.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: p.refreshToken ?? '',
          token_type_hint: 'refresh_token',
          client_id: p.clientId,
        }),
      });
      revoked = response.status === 200;
    } catch {
      /* Local removal still proceeds; status reports revocation uncertainty. */
    }
    p.accessToken = undefined;
    p.refreshToken = undefined;
    p.idToken = undefined;
    p.scopes = [];
    p.model = undefined;
    this.data.activeClientId = undefined;
    this.data.issuedClientId = id;
    this.data.modelProvider = 'openai-compatible';
    await this.save();
    return revoked;
  }
}
