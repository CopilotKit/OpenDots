import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolDefinition, type JSONSchema } from '@tanstack/ai';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Local MCP servers (files, vision, PC control, ...) shared by every Dot.
// Declared in mcp.servers.json so new capabilities plug in without code changes.
const serverSchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({ url: z.url(), enabled: z.boolean().default(true) }),
]);
const configSchema = z.record(z.string().regex(/^[a-z0-9_-]+$/i), serverSchema);
export type McpServers = z.infer<typeof configSchema>;

export function loadMcpServers(path = 'mcp.servers.json'): McpServers {
  if (!existsSync(path)) return {};
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

interface Connected {
  client: Client;
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

export class McpTools {
  private connections = new Map<string, Promise<Connected>>();
  private unavailableUntil = new Map<string, number>();
  constructor(private servers: McpServers) {}
  get configured() {
    return Object.values(this.servers).some((server) => server.enabled);
  }
  private connect(name: string): Promise<Connected> {
    let pending = this.connections.get(name);
    if (pending) return pending;
    if ((this.unavailableUntil.get(name) ?? 0) > Date.now())
      return Promise.reject(
        new Error(
          `MCP server ${name} is cooling down after a failed connection.`,
        ),
      );
    const server = this.servers[name];
    pending = (async () => {
      const client = new Client({ name: 'opendots', version: '0.1.0' });
      const transport =
        'url' in server
          ? new StreamableHTTPClientTransport(new URL(server.url))
          : new StdioClientTransport({
              command: resolve(server.command),
              args: server.args,
              env: {
                ...(process.env as Record<string, string>),
                ...server.env,
              },
              stderr: 'ignore',
            });
      const forget = () => {
        if (this.connections.get(name) === pending)
          this.connections.delete(name);
      };
      client.onclose = forget;
      // Discovery must not consume a minute of every Dot turn. Action calls
      // retain their longer timeout for owner confirmations and slow work.
      const signal = AbortSignal.timeout(10_000);
      try {
        await client.connect(transport, { signal, timeout: 10_000 });
        const { tools } = await client.listTools(undefined, {
          signal,
          timeout: 10_000,
        });
        this.unavailableUntil.delete(name);
        return { client, tools };
      } catch (error) {
        this.unavailableUntil.set(name, Date.now() + 60_000);
        await client.close().catch(() => {});
        throw error;
      }
    })();
    pending.catch(() => {
      if (this.connections.get(name) === pending) this.connections.delete(name);
    });
    this.connections.set(name, pending);
    return pending;
  }
  // Tool names are prefixed with the server name to keep them unique.
  async tools(
    check: () => void,
    signal: AbortSignal,
    allow: (server: string, tool: string) => boolean = () => true,
  ) {
    const enabled = Object.entries(this.servers).filter(([, s]) => s.enabled);
    const results = await Promise.allSettled(
      enabled.map(async ([name]) => {
        try {
          return { name, ...(await this.connect(name)) };
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`, { cause: error });
        }
      }),
    );
    return results.flatMap((result) => {
      if (result.status === 'rejected') {
        console.warn('MCP server unavailable:', String(result.reason));
        return [];
      }
      const { name, client, tools } = result.value;
      return tools
        .filter((tool) => allow(name, tool.name))
        .map((tool) =>
          toolDefinition({
            name: `${name}__${tool.name}`,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema as JSONSchema,
          }).server(async (input) => {
            check();
            const response = await client.callTool(
              {
                name: tool.name,
                arguments: (input ?? {}) as Record<string, unknown>,
              },
              undefined,
              // Confirmation dialogs wait on the owner, so allow a long call.
              { signal, timeout: 600_000 },
            );
            const text = (response.content as { type: string; text?: string }[])
              ?.filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
            if (response.isError) throw new Error(text || 'Tool failed.');
            return response.structuredContent ?? text;
          }),
        );
    });
  }
  /** Names of configured servers other than the built-in local tools. */
  extraServers() {
    return Object.entries(this.servers)
      .filter(([name, server]) => server.enabled && name !== 'localtools')
      .map(([name]) => name);
  }
  /** Owner settings support the bundled, local stdio server only. */
  localConfirmationConfig() {
    const server = this.servers.localtools;
    if (!server?.enabled || 'url' in server) return undefined;
    return {
      path: resolve(
        server.env?.LOCALTOOLS_CONFIRMATION_POLICY ??
          process.env.LOCALTOOLS_CONFIRMATION_POLICY ??
          'data/confirmation-policy.json',
      ),
      defaultConfirm:
        (server.env?.LOCALTOOLS_CONFIRM ??
          process.env.LOCALTOOLS_CONFIRM ??
          '1') !== '0',
    };
  }
  /** Calls one tool directly (used by the app itself, not by a model). */
  async call(server: string, tool: string, args: Record<string, unknown>) {
    if (!this.servers[server]?.enabled)
      throw new Error(`MCP server ${server} is not configured.`);
    const { client } = await this.connect(server);
    const response = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: 120_000 },
    );
    if (response.isError)
      throw new Error(
        (response.content as { text?: string }[])?.[0]?.text ?? 'Tool failed.',
      );
    return response;
  }
  async close() {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(all.map(async (c) => (await c).client.close()));
  }
}
