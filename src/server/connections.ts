import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  auth,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAUTH_CALLBACK_PATH,
  StoredOAuthProvider,
} from './connection-oauth.js';
import { z } from 'zod';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
import type { ConnectionStore } from './connection-store.js';
const MAX_TOOLS = 100;
const MAX_SCHEMA_BYTES = 16_000;
const MAX_RESULT_CHARS = 20_000;
export const connectionInput = z
  .object({
    name: z.string().trim().min(1).max(40),
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, 'Use an http(s) MCP endpoint without embedded credentials.'),
    token: z.string().trim().max(4096).optional(),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionInput>;
export type McpTransportFactory = (target: {
  url: string;
  token?: string;
  authProvider?: OAuthClientProvider;
  signal: AbortSignal;
}) => Transport;
export const httpTransport: McpTransportFactory = ({
  url,
  token,
  authProvider,
  signal,
}) =>
  new StreamableHTTPClientTransport(new URL(url), {
    authProvider,
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
const listedTool = z.object({
  name: z.string().min(1).max(128),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});
// Model-facing names must match ^[a-zA-Z0-9_-]{1,64}$ and stay unique across
// every connection a Dot has, so they are derived here, deterministically.
const slug = (value: string, max: number) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max) || 'tool';
export interface ExposedTool {
  name: string;
  connection: Connection;
  tool: ConnectionTool;
}
// Names are assigned over every tool, enabled or not, so turning one tool
// off never moves its name to another. Approvals do not rely on names: they
// bind to a stored connection, tool, and arguments.
export function exposedTools(connections: Connection[]): ExposedTool[] {
  const used = new Set<string>();
  return (
    connections
      .flatMap((connection) =>
        connection.tools.map((tool) => {
          const base = `${slug(connection.name, 20)}__${slug(tool.name, 40)}`;
          let name = base;
          for (let n = 2; used.has(name); n++)
            name = `${base.slice(0, 60)}_${n}`;
          used.add(name);
          return { name, connection, tool };
        }),
      )
      // A signed-out connection offers nothing until the owner signs in again.
      .filter(
        ({ connection, tool }) =>
          tool.enabled &&
          (connection.authMode !== 'oauth' || connection.signedIn),
      )
  );
}
export function normalizeResult(result: unknown): ConnectionActionResult {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(
          z
            .object({ type: z.string(), text: z.string().optional() })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .safeParse(result);
  if (!envelope.success)
    return {
      isError: true,
      text: 'The service returned an unreadable result.',
    };
  const parts = (envelope.data.content ?? []).map((item) =>
    item.type === 'text' ? (item.text ?? '') : `[${item.type} omitted]`,
  );
  if (!parts.some((part) => part.trim()) && envelope.data.structuredContent)
    parts.push(JSON.stringify(envelope.data.structuredContent));
  const text = parts.join('\n').trim() || '(no content)';
  return {
    isError: !!envelope.data.isError,
    text:
      text.length > MAX_RESULT_CHARS
        ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
        : text,
  };
}
// OAuth-protected servers surface UnauthorizedError or HTTP 401/403.
const unauthorized = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  const status = (error as { code?: unknown }).code;
  return (
    status === 401 ||
    status === 403 ||
    error.name === 'UnauthorizedError' ||
    error.constructor.name === 'UnauthorizedError'
  );
};
const failure = (error: unknown, authMode: 'token' | 'oauth' = 'token') => {
  if (!(error instanceof Error))
    return 'Could not reach the connected service.';
  if (error.name === 'AbortError' || error.name === 'TimeoutError')
    return 'The connected service did not respond in time.';
  if (unauthorized(error))
    return authMode === 'oauth'
      ? 'Sign in to this service again.'
      : 'The connected service rejected the credentials. Check the bearer token.';
  return `Could not reach the connected service${error.message ? `: ${error.message.slice(0, 200)}` : '.'}`;
};
export class ConnectionService {
  constructor(
    readonly store: ConnectionStore,
    private transport: McpTransportFactory = httpTransport,
    private timeoutMs = 60_000,
  ) {}
  private target(id: string) {
    const connection = this.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    return {
      ...this.store.credentials(id),
      ...(connection.authMode === 'oauth'
        ? { authProvider: new StoredOAuthProvider(this.store, id) }
        : {}),
    };
  }
  private async session<T>(
    target: { url: string; token?: string; authProvider?: OAuthClientProvider },
    signal: AbortSignal | undefined,
    use: (client: Client, signal: AbortSignal) => Promise<T>,
  ) {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const client = new Client({ name: 'opendots', version: '0.1.0' });
    try {
      await client.connect(this.transport({ ...target, signal: bounded }), {
        signal: bounded,
      });
      return await use(client, bounded);
    } finally {
      await client.close().catch(() => {});
    }
  }
  private async discover(
    target: { url: string; token?: string; authProvider?: OAuthClientProvider },
    previous: ConnectionTool[] = [],
  ) {
    return this.session(target, undefined, async (client, signal) => {
      const tools: ConnectionTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal,
        });
        for (const raw of page.tools) {
          const parsed = listedTool.safeParse(raw);
          if (!parsed.success || tools.length >= MAX_TOOLS) continue;
          const tool = parsed.data;
          if (JSON.stringify(tool.inputSchema).length > MAX_SCHEMA_BYTES)
            continue;
          const readOnly = tool.annotations?.readOnlyHint === true;
          const prior = previous.find((item) => item.name === tool.name);
          tools.push({
            name: tool.name,
            title: tool.title ?? tool.annotations?.title ?? tool.name,
            description: (tool.description ?? '').slice(0, 1000),
            inputSchema: { type: 'object', ...tool.inputSchema },
            readOnly,
            // New tools start enabled; anything not read-only needs approval.
            enabled: prior?.enabled ?? true,
            requiresApproval: prior?.requiresApproval ?? !readOnly,
          });
        }
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_TOOLS);
      return tools;
    });
  }
  async add(dotId: string, input: ConnectionInput) {
    const value = connectionInput.parse(input);
    let tools: ConnectionTool[];
    try {
      tools = await this.discover({ url: value.url, token: value.token });
    } catch (error) {
      // No token and the server wants one: save it for the owner to sign in.
      if (!value.token && unauthorized(error))
        return this.store.create(dotId, value, [], 'oauth');
      throw new Error(failure(error), { cause: error });
    }
    return this.store.create(dotId, value, tools);
  }
  // Starts an owner sign-in. Returns the provider's authorization URL for
  // the owner's browser, or the refreshed connection if already authorized.
  async signIn(id: string, appOrigin: string) {
    const connection = this.store.get(id);
    if (connection?.authMode !== 'oauth')
      throw new Error('This connection does not use sign-in.');
    this.store.saveOAuth(id, {
      redirectUrl: `${appOrigin.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`,
    });
    const provider = new StoredOAuthProvider(this.store, id, true);
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, { serverUrl: connection.url });
    } catch (error) {
      throw new Error(
        `Could not start sign-in: ${error instanceof Error ? error.message.slice(0, 200) : 'the service did not respond.'}`,
        { cause: error },
      );
    }
    if (result === 'AUTHORIZED') return { connection: await this.refresh(id) };
    const url = provider.authorizationUrl;
    // The URL comes from the remote server's metadata; only open web pages.
    if (!url || !['https:', 'http:'].includes(url.protocol))
      throw new Error('The service returned an invalid sign-in address.');
    return { authorizationUrl: url.toString() };
  }
  async completeSignIn(state: string, code: string) {
    const id = this.store.takeState(state);
    if (!id) throw new Error('This sign-in link expired. Start sign-in again.');
    const connection = this.store.get(id)!;
    try {
      await auth(new StoredOAuthProvider(this.store, id), {
        serverUrl: connection.url,
        authorizationCode: code,
      });
    } catch (error) {
      throw new Error(
        `The service did not accept the sign-in: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error.'}`,
        { cause: error },
      );
    }
    return this.refresh(id);
  }
  signOut(id: string) {
    const connection = this.store.get(id);
    if (connection?.authMode !== 'oauth')
      throw new Error('This connection does not use sign-in.');
    this.store.saveOAuth(id, { tokens: undefined, verifier: null });
    return this.store.get(id)!;
  }
  async refresh(id: string) {
    const connection = this.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    try {
      const discovered = await this.discover(this.target(id));
      // Owner changes made while discovery ran win: merge against the
      // settings as they are now, not as they were when it started.
      const current = this.store.get(id);
      if (!current) throw new Error('Connection not found.');
      return this.store.saveTools(
        id,
        discovered.map((tool) => {
          const owner = current.tools.find((item) => item.name === tool.name);
          return owner
            ? {
                ...tool,
                enabled: owner.enabled,
                requiresApproval: owner.requiresApproval,
              }
            : tool;
        }),
      );
    } catch (error) {
      return this.store.setError(id, failure(error, connection.authMode));
    }
  }
  setTool(
    id: string,
    name: string,
    patch: { enabled?: boolean; requiresApproval?: boolean },
  ) {
    const connection = this.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    if (!connection.tools.some((tool) => tool.name === name))
      throw new Error('Connection tool not found.');
    return this.store.saveTools(
      id,
      connection.tools.map((tool) =>
        tool.name === name ? { ...tool, ...patch } : tool,
      ),
      connection.error,
    );
  }
  tools(dotId: string) {
    return exposedTools(this.store.list(dotId));
  }
  resolve(dotId: string, name: string) {
    const match = this.tools(dotId).find((tool) => tool.name === name);
    if (!match)
      throw new Error('Connection tool is not available to this Dot.');
    return match;
  }
  // The tool an approval was created for, by connection and real tool name,
  // if the Dot still has it enabled.
  bound(dotId: string, connectionId: string, toolName: string) {
    const match = this.tools(dotId).find(
      (item) =>
        item.connection.id === connectionId && item.tool.name === toolName,
    );
    if (!match)
      throw new Error(
        'This tool is no longer enabled for this Dot. Nothing was run.',
      );
    return match;
  }
  async call(
    exposed: ExposedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult> {
    try {
      return await this.session(
        this.target(exposed.connection.id),
        signal,
        async (client, bounded) =>
          normalizeResult(
            await client.callTool(
              { name: exposed.tool.name, arguments: args },
              undefined,
              { signal: bounded },
            ),
          ),
      );
    } catch (error) {
      return {
        isError: true,
        text: failure(error, exposed.connection.authMode),
      };
    }
  }
}
