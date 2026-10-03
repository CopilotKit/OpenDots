import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
  signal: AbortSignal;
}) => Transport;
export const httpTransport: McpTransportFactory = ({ url, token, signal }) =>
  new StreamableHTTPClientTransport(new URL(url), {
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
export function exposedTools(connections: Connection[]): ExposedTool[] {
  const used = new Set<string>();
  return connections.flatMap((connection) =>
    connection.tools
      .filter((tool) => tool.enabled)
      .map((tool) => {
        const base = `${slug(connection.name, 20)}__${slug(tool.name, 40)}`;
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
        used.add(name);
        return { name, connection, tool };
      }),
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
const failure = (error: unknown) => {
  if (!(error instanceof Error))
    return 'Could not reach the connected service.';
  if (error.name === 'AbortError' || error.name === 'TimeoutError')
    return 'The connected service did not respond in time.';
  const status = (error as { code?: unknown }).code;
  // OAuth-only servers surface UnauthorizedError when no token is supplied.
  if (
    status === 401 ||
    status === 403 ||
    error.name === 'UnauthorizedError' ||
    error.constructor.name === 'UnauthorizedError'
  )
    return 'The connected service rejected the credentials. Check the bearer token.';
  return `Could not reach the connected service${error.message ? `: ${error.message.slice(0, 200)}` : '.'}`;
};
export class ConnectionService {
  constructor(
    readonly store: ConnectionStore,
    private transport: McpTransportFactory = httpTransport,
    private timeoutMs = 60_000,
  ) {}
  private async session<T>(
    target: { url: string; token?: string },
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
    target: { url: string; token?: string },
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
      throw new Error(failure(error), { cause: error });
    }
    return this.store.create(dotId, value, tools);
  }
  async refresh(id: string) {
    const connection = this.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    try {
      return this.store.saveTools(
        id,
        await this.discover(this.store.credentials(id), connection.tools),
      );
    } catch (error) {
      return this.store.setError(id, failure(error));
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
  async call(
    exposed: ExposedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult> {
    try {
      return await this.session(
        this.store.credentials(exposed.connection.id),
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
      return { isError: true, text: failure(error) };
    }
  }
}
