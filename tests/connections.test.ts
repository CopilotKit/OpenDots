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
function fixture({ twin = false } = {}) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'A conversation');
  const sent = vi.fn();
  const sentTwin = vi.fn();
  const tokens: (string | undefined)[] = [];
  // Holds tools/list open while set, to interleave owner changes.
  const gate: { wait?: Promise<void> } = {};
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
    // Normalizes to the same model-facing base name as "send mail!".
    if (twin)
      server.registerTool(
        'send mail?',
        {
          description: 'Send an email to everyone.',
          inputSchema: { to: z.string(), body: z.string() },
        },
        async (args) => {
          sentTwin(args);
          return { content: [{ type: 'text', text: 'Sent to everyone' }] };
        },
      );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    const send = client.send.bind(client);
    client.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/list' && gate.wait)
        await gate.wait;
      return send(message, options);
    };
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
  return {
    workspace,
    dot,
    connections,
    routes,
    request,
    sent,
    sentTwin,
    tokens,
    gate,
  };
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
const tools = (
  connections: ConnectionService,
  dotId: string,
  approvals = true,
  threadId = 'thread',
) =>
  connectionTools(
    connections,
    dotId,
    threadId,
    () => {},
    new AbortController().signal,
    approvals,
  );
const requestApproval = async (
  connections: ConnectionService,
  dotId: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = tools(connections, dotId).find((item) => item.name === name)!;
  const result = (await tool.execute!(args, toolCtx)) as {
    status: string;
    approvalId: string;
  };
  expect(result.status).toBe('approval_required');
  return result.approvalId;
};
it('runs read-only tools directly and holds write tools for owner approval', async () => {
  const { dot, connections, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const search = tools(connections, dot.id).find(
    (tool) => tool.name === 'mail__search_mail',
  )!;
  expect(await search.execute!({ query: 'invoices' }, toolCtx)).toEqual({
    isError: false,
    text: '3 results for invoices',
  });
  await requestApproval(connections, dot.id, 'mail__send_mail', {
    to: 'a@example.com',
    body: 'Hi',
  });
  expect(sent).not.toHaveBeenCalled();
  const headless = tools(connections, dot.id, false).find(
    (tool) => tool.name === 'mail__send_mail',
  )!;
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
  const [search] = tools(connections, dot.id);
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
it('runs the stored request once on approval and restores its result', async () => {
  const { dot, connections, request, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const approvalId = await requestApproval(
    connections,
    dot.id,
    'mail__send_mail',
    { to: 'a@example.com', body: 'Hi' },
  );
  const preview = await request(
    `/conversations/thread/connection-approvals/${approvalId}`,
  );
  expect(await preview.json()).toMatchObject({
    connection: 'Mail',
    title: 'send mail!',
    arguments: { to: 'a@example.com', body: 'Hi' },
  });
  const approve = () =>
    request('/conversations/thread/connection-actions', 'POST', {
      toolCallId: 'tc1',
      approvalId,
    });
  expect(await (await approve()).json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  expect(await (await approve()).json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  expect(sent).toHaveBeenCalledOnce();
  expect(sent.mock.calls[0][0]).toEqual({ to: 'a@example.com', body: 'Hi' });
  const restored = await request(
    '/conversations/thread/connection-actions/tc1',
  );
  expect(await restored.json()).toMatchObject({ status: 'done' });
  expect(
    await (
      await request('/conversations/thread/connection-actions/other')
    ).json(),
  ).toBeNull();
  // Arguments sent with an approval are not accepted: only the stored ones run.
  const injected = await request(
    '/conversations/thread/connection-actions',
    'POST',
    { toolCallId: 'tc2', approvalId, arguments: { to: 'evil@example.com' } },
  );
  expect(injected.status).toBe(400);
});
it('binds approvals to the exact tool, even when look-alike names collide', async () => {
  const { dot, connections, request, sent, sentTwin } = fixture({
    twin: true,
  });
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const names = () =>
    Object.fromEntries(
      connections.tools(dot.id).map((item) => [item.tool.name, item.name]),
    );
  expect(names()).toMatchObject({
    'send mail!': 'mail__send_mail',
    'send mail?': 'mail__send_mail_2',
  });
  const approvalId = await requestApproval(
    connections,
    dot.id,
    'mail__send_mail',
    { to: 'a@example.com', body: 'Hi' },
  );
  // Disabling the requested tool must not hand its name or approval to the twin.
  connections.setTool(connection.id, 'send mail!', { enabled: false });
  expect(names()).toEqual({
    search_mail: 'mail__search_mail',
    'send mail?': 'mail__send_mail_2',
  });
  const refused = await request(
    '/conversations/thread/connection-actions',
    'POST',
    { toolCallId: 'tc1', approvalId },
  );
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({
    error: 'This tool is no longer enabled for this Dot. Nothing was run.',
  });
  expect(sent).not.toHaveBeenCalled();
  expect(sentTwin).not.toHaveBeenCalled();
});
it('refuses approvals from other conversations, other Dots, or after expiry', async () => {
  const { dot, connections, request, workspace, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const other = workspace.createDot(
    dot.spaceId,
    'Other',
    'Another specialist.',
    true,
    true,
  );
  workspace.bindThread('other-thread', other.id, 'Elsewhere');
  const approvalId = await requestApproval(
    connections,
    dot.id,
    'mail__send_mail',
    { to: 'a', body: 'b' },
  );
  for (const thread of ['other-thread', 'missing'])
    expect(
      (
        await request(`/conversations/${thread}/connection-actions`, 'POST', {
          toolCallId: 'x',
          approvalId,
        })
      ).status,
    ).toBe(400);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const expired = await request(
      '/conversations/thread/connection-actions',
      'POST',
      { toolCallId: 'late', approvalId },
    );
    expect(await expired.json()).toEqual({
      error: 'This approval request expired. Ask the Dot to try again.',
    });
  } finally {
    vi.useRealTimers();
  }
  expect(sent).not.toHaveBeenCalled();
});
it('keeps owner changes made while a refresh is discovering tools', async () => {
  const { dot, connections, gate } = fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  let release!: () => void;
  gate.wait = new Promise((resolve) => (release = resolve));
  const refreshing = connections.refresh(connection.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Revoke and gate while discovery is still pending.
  connections.setTool(connection.id, 'send mail!', { enabled: false });
  connections.setTool(connection.id, 'search_mail', { requiresApproval: true });
  gate.wait = undefined;
  release();
  const refreshed = await refreshing;
  expect(
    refreshed.tools.map(({ name, enabled, requiresApproval }) => ({
      name,
      enabled,
      requiresApproval,
    })),
  ).toEqual([
    { name: 'search_mail', enabled: true, requiresApproval: true },
    { name: 'send mail!', enabled: false, requiresApproval: true },
  ]);
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
it('returns a saved result only for the approval that produced it', async () => {
  const { dot, connections, request, sent } = fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const alice = await requestApproval(connections, dot.id, 'mail__send_mail', {
    to: 'alice@example.com',
    body: 'Hi',
  });
  const bob = await requestApproval(connections, dot.id, 'mail__send_mail', {
    to: 'bob@example.com',
    body: 'Hi',
  });
  const approve = (approvalId: string) =>
    request('/conversations/thread/connection-actions', 'POST', {
      toolCallId: 'tc1',
      approvalId,
    });
  expect(await (await approve(alice)).json()).toEqual({
    isError: false,
    text: 'Sent to alice@example.com',
  });
  // Bob's approval must not be shown Alice's result, nor run under her call.
  const mismatched = await approve(bob);
  expect(mismatched.status).toBe(409);
  expect(await mismatched.json()).toEqual({
    error: 'This action belongs to a different approval request.',
  });
  // The receipt names its approval, so the card can reject a mismatch too.
  const receipt = await request('/conversations/thread/connection-actions/tc1');
  expect(await receipt.json()).toMatchObject({
    approvalId: alice,
    status: 'done',
  });
  // Retrying the original approval still recovers its result.
  expect(await (await approve(alice)).json()).toEqual({
    isError: false,
    text: 'Sent to alice@example.com',
  });
  expect(sent).toHaveBeenCalledOnce();
  expect(sent.mock.calls[0][0]).toMatchObject({ to: 'alice@example.com' });
});
