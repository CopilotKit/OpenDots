import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    onclose?: () => void;
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void;
    connect = vi.fn(async () => {});
    listTools = vi.fn(async () => ({ tools: [] }));
    close = vi.fn(async () => {
      this.onclose?.();
    });
    constructor() {
      mocks.clients.push(this);
    }
  },
}));
import { McpTools } from '../src/server/mcp-tools.js';
afterEach(() => {
  mocks.clients.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('bounds discovery, closes a failed client and retries only after cooldown', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const tools = new McpTools({
    test: { url: 'http://127.0.0.1:9999/mcp', enabled: true },
  });
  const first = tools.tools(() => {}, new AbortController().signal);
  mocks.clients[0].listTools.mockRejectedValueOnce(
    new Error('Request timed out'),
  );
  expect(await first).toEqual([]);
  expect(mocks.clients[0].connect).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      timeout: 10000,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(mocks.clients[0].close).toHaveBeenCalledTimes(1);
  await tools.tools(() => {}, new AbortController().signal);
  expect(mocks.clients).toHaveLength(1);
  vi.advanceTimersByTime(60001);
  await tools.tools(() => {}, new AbortController().signal);
  expect(mocks.clients).toHaveLength(2);
  mocks.clients[1].onclose?.();
  await tools.tools(() => {}, new AbortController().signal);
  expect(mocks.clients).toHaveLength(3);
  await tools.close();
});
