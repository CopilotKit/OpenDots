import { createServer, type Server } from 'node:http';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, chmod, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const profileSchema = z.object({
  clientId: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().optional(),
  model: z.string().optional(),
});
const fileSchema = z
  .object({
    version: z.literal(1),
    extAgentHostId: z.string().uuid(),
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
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  previousSubject?: string;
  server: Server;
  consumed: boolean;
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
      extAgentHostId: randomUUID(),
      profiles: {},
    };
    let contents: string | undefined;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Could not read the ChatGPT credential file. Check its permissions.',
          { cause: error },
        );
    }
    let invalid = false;
    if (contents !== undefined) {
      try {
        data = fileSchema.parse(JSON.parse(contents));
      } catch {
        invalid = true;
      }
    }
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
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.data), {
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await chmod(temp, 0o600);
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
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
      email: p?.email,
      model: p?.model,
      name: p?.name,
      provider: 'chatgpt-plan' as const,
    };
  }
  provider() {
    return (
      this.data.modelProvider ??
      (this.active() ? 'chatgpt-plan' : 'openai-compatible')
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

  async start(): Promise<string> {
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
      if (!pending || pending.server !== server || pending.consumed) {
        res
          .writeHead(410)
          .end('Sign-in expired. Return to OpenDots and try again.');
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
    const current = this.active();
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
    };
    this.attempt = attempt;
    const expiry = setTimeout(() => {
      if (this.attempt === attempt) this.cancel();
    }, 10 * 60_000);
    expiry.unref();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL(`${issuer}/api/accounts/authorize`);
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
    if (current?.idToken) params.id_token_hint = current.idToken;
    if (current?.email) params.login_hint = current.email;
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
    const response = await fetch(tokenEndpoint, {
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
        earliest_refresh_at: z.number().optional(),
      })
      .safeParse(raw);
    if (!response.ok || !token.success)
      throw new Error('ChatGPT token exchange failed.');
    if (this.attempt !== a) throw new Error('ChatGPT sign-in was cancelled.');
    const { payload } = await jwtVerify(token.data.id_token, jwks, {
      issuer,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
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
    if (!granted.includes('chatgpt.tokens.use.direct'))
      throw new Error('ChatGPT plan usage permission was not granted.');
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
      earliestRefreshAt: token.data.earliest_refresh_at
        ? token.data.earliest_refresh_at * 1000
        : undefined,
    };
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
    if (p.expiresAt > Date.now() + 120_000) return p.accessToken;
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
    if (p.earliestRefreshAt && Date.now() < p.earliestRefreshAt)
      await new Promise((r) =>
        setTimeout(r, p.earliestRefreshAt! - Date.now()),
      );
    const response = await fetch(tokenEndpoint, {
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
        refresh_token: z.string().min(1),
        expires_in: z.number().positive(),
        scope: z.string().optional(),
        earliest_refresh_at: z.number().optional(),
      })
      .safeParse(raw);
    if (!response.ok || !result.success)
      throw new Error(
        'ChatGPT connection needs attention. Reconnect ChatGPT or switch providers in Settings.',
      );
    p.accessToken = result.data.access_token;
    p.refreshToken = result.data.refresh_token;
    p.expiresAt = Date.now() + result.data.expires_in * 1000;
    p.earliestRefreshAt = result.data.earliest_refresh_at
      ? result.data.earliest_refresh_at * 1000
      : undefined;
    if (result.data.scope)
      p.scopes = result.data.scope.split(/\s+/).filter(Boolean);
    await this.save();
    if (!p.scopes.includes('chatgpt.tokens.use.direct'))
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
      const discovery = z
        .object({ revocation_endpoint: z.string().url() })
        .parse(
          await (
            await fetch(`${issuer}/.well-known/openid-configuration`)
          ).json(),
        );
      const response = await fetch(discovery.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: p.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: p.clientId,
        }),
      });
      revoked = response.status === 200;
    } catch {
      /* Local removal still proceeds; status reports revocation uncertainty. */
    }
    delete this.data.profiles[id];
    this.data.activeClientId = undefined;
    this.data.modelProvider = 'openai-compatible';
    await this.save();
    return revoked;
  }
}
