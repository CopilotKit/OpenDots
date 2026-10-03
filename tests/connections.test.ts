import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  ConnectionService,
  exposedTools,
  normalizeResult,
  type McpTransportFactory,
} from '../src/server/connections.js';
import { connectionTools } from '../src/server/connection-tools.js';
import { connectionRoutes } from '../src/server/connection-routes.js';
import type { Connection } from '../src/shared/connection-types.js';
const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));
function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'A conversation');
  const sent = vi.fn();
  const tokens: (string | undefined)[] = [];
  const transport: McpTransportFactory = ({ token }) => {
    tokens.push(token);
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'search_mail',
      {
        description: 'Search the inbox.',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => ({
        content: [{ type: 'text', text: `3 results for ${query}` }],
      }),
    );
    server.registerTool(
      'send mail!',
      {
        description: 'Send an email.',
        inputSchema: { to: z.string(), body: z.string() },
      },
      async (args) => {
        sent(args);
        return { content: [{ type: 'text', text: `Sent to ${args.to}` }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  const connections = new ConnectionService(workspace.connections, transport);
  const routes = connectionRoutes(workspace, connections);
  const request = (path: string, method = 'GET', body?: unknown) =>
    routes.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { workspace, dot, connections, routes, request, sent, tokens };
}
const toolCtx = { toolCallId: 'call' } as never;
it('discovers tools, gates anything not read-only, and never returns the token', async () => {
  const { dot, request, tokens } = fixture();
  const response = await request(`/dots/${dot.id}/connections`, 'POST', {
    name: 'Work Mail',
    url: 'https://mail.example.com/mcp',
    token: 'secret-token',
  });
  expect(response.status).toBe(201);
  const connection = (await response.json()) as Connection & {
    token?: string;
  };
  expect(tokens).toEqual(['secret-token']);
  expect(connection.hasToken).toBe(true);
  expect(connection.token).toBeUndefined();
  expect(JSON.stringify(connection)).not.toContain('secret-token');
  expect(
    connection.tools.map(({ name, readOnly, requiresApproval, enabled }) => ({
      name,
      readOnly,
      requiresApproval,
      enabled,
    })),
  ).toEqual([
    {
      name: 'search_mail',
      readOnly: true,
      requiresApproval: false,
      enabled: true,
    },
    {
      name: 'send mail!',
      readOnly: false,
      requiresApproval: true,
      enabled: true,
    },
  ]);
});
it('rejects endpoints with embedded credentials or non-http schemes', async () => {
  const { dot, request } = fixture();
  for (const url of ['https://user:pw@example.com/mcp', 'file:///etc/passwd']) {
    const response = await request(`/dots/${dot.id}/connections`, 'POST', {
      name: 'Bad',
      url,
    });
    expect(response.status).toBe(400);
  }
});
it('derives unique, provider-safe tool names', () => {
  const tool = (name: string) => ({
    name,
    title: name,
    description: '',
    inputSchema: { type: 'object' },
    readOnly: true,
    enabled: true,
    requiresApproval: false,
  });
  const connection = (id: string, name: string, tools: string[]) =>
    ({ id, name, tools: tools.map(tool) }) as unknown as Connection;
  const names = exposedTools([
    connection('a', 'Work Mail', ['send mail!', 'send-mail']),
    connection('b', 'work mail', ['send mail!']),
  ]).map((tool) => tool.name);
  expect(names).toEqual([
    'work_mail__send_mail',
    'work_mail__send-mail',
    'work_mail__send_mail_2',
  ]);
  for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
});
it('runs read-only tools directly and holds write tools for owner approval', async () => {
  const { dot, connections, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const tools = connectionTools(
    connections,
    dot.id,
    () => {},
    new AbortController().signal,
    true,
  );
  const search = tools.find((tool) => tool.name === 'mail__search_mail')!;
  const send = tools.find((tool) => tool.name === 'mail__send_mail')!;
  expect(await search.execute!({ query: 'invoices' }, toolCtx)).toEqual({
    isError: false,
    text: '3 results for invoices',
  });
  expect(
    await send.execute!({ to: 'a@example.com', body: 'Hi' }, toolCtx),
  ).toMatchObject({ status: 'approval_required' });
  expect(sent).not.toHaveBeenCalled();
  const headless = connectionTools(
    connections,
    dot.id,
    () => {},
    new AbortController().signal,
    false,
  ).find((tool) => tool.name === 'mail__send_mail')!;
  expect(
    await headless.execute!({ to: 'a@example.com', body: 'Hi' }, toolCtx),
  ).toMatchObject({ status: 'unavailable' });
  expect(sent).not.toHaveBeenCalled();
});
it('honors owner changes to a tool, including during a turn', async () => {
  const { dot, connections, workspace } = fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const [search] = connectionTools(
    connections,
    dot.id,
    () => {},
    new AbortController().signal,
    true,
  );
  const before = workspace.connections.fingerprint(dot.id);
  connections.setTool(connection.id, 'search_mail', { requiresApproval: true });
  expect(workspace.connections.fingerprint(dot.id)).not.toBe(before);
  expect(await search.execute!({ query: 'x' }, toolCtx)).toMatchObject({
    status: 'approval_required',
  });
  connections.setTool(connection.id, 'search_mail', { enabled: false });
  expect(connections.tools(dot.id).map((tool) => tool.name)).toEqual([
    'mail__send_mail',
  ]);
  await expect(search.execute!({ query: 'x' }, toolCtx)).rejects.toThrow(
    'not available',
  );
});
it('runs an approved action once and restores its result', async () => {
  const { dot, connections, request, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const action = {
    toolCallId: 'tc1',
    tool: 'mail__send_mail',
    arguments: { to: 'a@example.com', body: 'Hi' },
  };
  const first = await request(
    '/conversations/thread/connection-actions',
    'POST',
    action,
  );
  expect(await first.json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  const again = await request(
    '/conversations/thread/connection-actions',
    'POST',
    action,
  );
  expect(await again.json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  expect(sent).toHaveBeenCalledOnce();
  const restored = await request(
    '/conversations/thread/connection-actions/tc1',
  );
  expect(await restored.json()).toMatchObject({ status: 'done' });
  expect(
    await (
      await request('/conversations/thread/connection-actions/other')
    ).json(),
  ).toBeNull();
});
it('refuses approvals for tools the Dot does not have or threads it does not own', async () => {
  const { dot, connections, request, workspace, sent } = fixture();
  const other = workspace.createDot(
    dot.spaceId,
    'Other',
    'Another specialist.',
    true,
    true,
  );
  await connections.add(other.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  for (const [thread, tool] of [
    ['thread', 'mail__send_mail'],
    ['missing', 'mail__send_mail'],
  ]) {
    const response = await request(
      `/conversations/${thread}/connection-actions`,
      'POST',
      { toolCallId: 'x', tool, arguments: { to: 'a', body: 'b' } },
    );
    expect(response.status).toBe(400);
  }
  expect(sent).not.toHaveBeenCalled();
});
it('keeps owner choices on refresh and reports unreachable services', async () => {
  const { dot, connections } = fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  connections.setTool(connection.id, 'send mail!', { enabled: false });
  const refreshed = await connections.refresh(connection.id);
  expect(
    refreshed.tools.find((tool) => tool.name === 'send mail!'),
  ).toMatchObject({ enabled: false, requiresApproval: true });
  expect(refreshed.error).toBeNull();
  const offline = new ConnectionService(connections.store, () => {
    throw new Error('connect ECONNREFUSED');
  });
  const failed = await offline.refresh(connection.id);
  expect(failed.error).toContain('ECONNREFUSED');
  expect(failed.tools).toHaveLength(2);
  await expect(
    offline.add(dot.id, { name: 'Down', url: 'https://down.example.com' }),
  ).rejects.toThrow('Could not reach the connected service');
});
it('normalizes and bounds tool results', () => {
  expect(
    normalizeResult({
      isError: true,
      content: [
        { type: 'text', text: 'Quota exceeded' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ],
    }),
  ).toEqual({ isError: true, text: 'Quota exceeded\n[image omitted]' });
  expect(normalizeResult({ structuredContent: { ok: true } }).text).toBe(
    '{"ok":true}',
  );
  expect(
    normalizeResult({ content: [{ type: 'text', text: 'x'.repeat(30000) }] })
      .text,
  ).toHaveLength(20000 + '\n[truncated]'.length);
  expect(normalizeResult('nope').isError).toBe(true);
});
