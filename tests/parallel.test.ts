import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parallelSources,
  sourcesFromResult,
} from '../src/server/parallel.js';
import { research } from '../src/server/research.js';
import { parallelEnvSchema } from '../src/config/env/parallel.js';
const mcp = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mcp.connect;
    callTool = mcp.callTool;
    close = mcp.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));
const page = (url = 'https://example.com') => ({
  title: 'Evidence',
  url,
  excerpts: ['Verified evidence.'],
});
const result = (...results: unknown[]) => ({ structuredContent: { results } });
beforeEach(() => {
  vi.clearAllMocks();
  mcp.connect.mockResolvedValue(undefined);
  mcp.close.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
const signal = new AbortController().signal;
describe('Parallel research', () => {
  it('defaults to Parallel and rejects invalid configuration', () => {
    expect(parallelEnvSchema.parse({}).WEB_SEARCH_PROVIDER).toBe('parallel');
    expect(
      parallelEnvSchema.parse({ WEB_SEARCH_PROVIDER: 'browser' })
        .WEB_SEARCH_PROVIDER,
    ).toBe('browser');
    expect(
      parallelEnvSchema.parse({ WEB_SEARCH_PROVIDER: 'disabled' })
        .WEB_SEARCH_PROVIDER,
    ).toBe('disabled');
    expect(() =>
      parallelEnvSchema.parse({ WEB_SEARCH_PROVIDER: 'other' }),
    ).toThrow();
  });
  it('searches, extracts and grounds a topic-only brief without a browser', async () => {
    mcp.callTool
      .mockResolvedValueOnce(result(page(), page('https://example.org')))
      .mockResolvedValueOnce(result(page(), page('https://example.org')));
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: 'Cited brief.' } }] }),
      );
    vi.stubGlobal('fetch', fetch);
    const output = await research(
      'Compare research methods',
      [],
      {
        mode: 'live',
        apiKey: 'model-key',
        model: 'test-model',
        baseUrl: 'https://model.example',
      },
      signal,
      () => {},
    );
    expect(output.sources).toHaveLength(2);
    expect(mcp.callTool.mock.calls.map(([call]) => call.name)).toEqual([
      'web_search',
      'web_fetch',
    ]);
    expect(mcp.callTool.mock.calls[0][0].arguments.session_id).toBe(
      mcp.callTool.mock.calls[1][0].arguments.session_id,
    );
    expect(
      JSON.parse(fetch.mock.calls[0][1].body).messages[1].content,
    ).toContain('Verified evidence.');
    expect(mcp.close).toHaveBeenCalledOnce();
  });
  it('extracts supplied URLs directly and preserves session identity', async () => {
    mcp.callTool.mockResolvedValue(result(page()));
    await parallelSources(
      {
        objective: 'Read',
        urls: ['https://example.com'],
        sessionId: 'conversation-1',
      },
      {},
      signal,
    );
    expect(mcp.callTool).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'web_fetch',
        arguments: expect.objectContaining({ session_id: 'conversation-1' }),
      }),
      undefined,
      expect.anything(),
    );
  });
  it('filters malformed sources, duplicate URLs and unsafe citation schemes', () => {
    expect(
      sourcesFromResult(
        result(
          page(),
          page(),
          page('javascript:alert(1)'),
          { url: 'https://empty.example', excerpts: [] },
          { bad: true },
        ),
      ),
    ).toHaveLength(1);
  });
  it('surfaces provider errors and closes the client', async () => {
    mcp.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'rate limit' }],
    });
    await expect(
      parallelSources({ objective: 'Research' }, {}, signal),
    ).rejects.toThrow('Parallel could not complete');
    expect(mcp.close).toHaveBeenCalledOnce();
  });
  it('stops before connecting when cancelled or disabled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parallelSources({ objective: 'Research' }, {}, controller.signal),
    ).rejects.toThrow();
    await expect(
      parallelSources(
        { objective: 'Research' },
        { webSearchProvider: 'disabled' },
        signal,
      ),
    ).rejects.toThrow('disabled');
    expect(mcp.connect).not.toHaveBeenCalled();
  });
  it('propagates cancellation while reading a provider result', async () => {
    const controller = new AbortController();
    mcp.callTool.mockImplementation(
      async (_call, _schema, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
    );
    await expect(
      parallelSources(
        { objective: 'Read', urls: ['https://example.com'] },
        {},
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mcp.close).toHaveBeenCalledOnce();
  });
});

it('preserves long research intent and records partial source failures', async () => {
  const objective =
    'Compare approaches. '.repeat(20) + 'Focus on access for blind users.';
  mcp.callTool
    .mockResolvedValueOnce(result(page(), page('https://other.example')))
    .mockResolvedValueOnce({
      structuredContent: {
        results: [page()],
        errors: [{ url: 'https://other.example', error_type: 'failed' }],
      },
    });
  const warn = vi.fn();
  await parallelSources({ objective, onWarning: warn }, {}, signal);
  expect(mcp.callTool.mock.calls[0][0].arguments.objective).toBe(objective);
  expect(mcp.callTool.mock.calls[1][0].arguments.search_queries).toEqual([
    objective,
  ]);
  expect(
    mcp.callTool.mock.calls[1][0].arguments.objective.length,
  ).toBeLessThanOrEqual(200);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('coverage is incomplete'),
  );
});
