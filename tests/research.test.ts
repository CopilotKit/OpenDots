import { afterEach, describe, expect, it, vi } from 'vitest';
import { research, type Config } from '../src/server/research.js';
const signal = new AbortController().signal;
const config: Config = {
  mode: 'live',
  apiKey: 'secret',
  model: 'test-model',
  baseUrl: 'https://model.example/v1',
  browserUrl: 'http://browser:4311',
  browserSecret: 'browser-secret',
};
afterEach(() => vi.unstubAllGlobals());
describe('research adapters', () => {
  const chatgptConfig: Config = {
    mode: 'live',
    baseUrl: 'https://unused.invalid/v1',
    browserUrl: 'http://browser:4311',
    browserSecret: 'browser-secret',
    modelProvider: () => 'chatgpt-plan',
    chatgptAuth: {
      status: () => ({
        connected: true,
        usable: true,
        sharing: true,
        model: 'listed-model',
      }),
      getValidAccessToken: async () => 'fixture-oauth-token',
    } as never,
  };
  const sse = (...events: unknown[]) =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  const browser = () =>
    Response.json({
      title: 'Page',
      url: 'https://example.com',
      text: 'Source text',
    });
  it('does not contact providers in sample mode and labels every result', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await research(
      'Something useful',
      [],
      { mode: 'sample', baseUrl: '' },
      signal,
      () => {},
    );
    expect(result.sample).toBe(true);
    expect(result.text).toContain('fictional');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails visibly for missing live config and unsupported search', async () => {
    await expect(
      research('Research', [], { mode: 'live', baseUrl: '' }, signal, () => {}),
    ).rejects.toThrow('not configured');
    await expect(
      research('Research', [], config, signal, () => {}),
    ).rejects.toThrow('include a public');
  });
  it('grounds model input in browser evidence and returns provider output', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          title: 'Evidence',
          url: 'https://example.com',
          text: 'Verified source text',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: 'A grounded brief.' } }],
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await research(
      'Summarize https://example.com',
      [],
      config,
      signal,
      () => {},
    );
    expect(result.text).toBe('A grounded brief.');
    expect(result.sample).toBe(false);
    expect(
      JSON.parse(fetch.mock.calls[1][1].body).messages[1].content,
    ).toContain('Verified source text');
  });
  it('surfaces browser and model failures without presenting success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'Blocked address' }, { status: 502 }),
        ),
    );
    await expect(
      research('Read https://example.com', [], config, signal, () => {}),
    ).rejects.toThrow('Blocked address');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            title: 'Page',
            url: 'https://example.com',
            text: 'Source',
          }),
        )
        .mockResolvedValueOnce(new Response('', { status: 429 })),
    );
    await expect(
      research('Read https://example.com', [], config, signal, () => {}),
    ).rejects.toThrow('429');
  });

  it('requires response.completed and maps usage-sharing stream errors in direct plan research', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(browser())
      .mockResolvedValueOnce(
        sse(
          { type: 'response.output_text.delta', delta: 'Grounded brief.' },
          {
            type: 'response.completed',
            response: { id: 'resp-1', output: [] },
          },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const completed = await research(
      'Summarize https://example.com',
      [],
      chatgptConfig,
      signal,
      () => {},
    );
    expect(completed.text).toBe('Grounded brief.');
    expect(JSON.parse(fetch.mock.calls[1][1].body).store).toBe(false);
    expect(JSON.parse(fetch.mock.calls[1][1].body).stream).toBe(true);

    for (const [event, expected] of [
      [
        {
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded' },
          },
        },
        /usage limit was reached/i,
      ],
      [
        {
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_unavailable' },
          },
        },
        /temporarily unavailable/i,
      ],
      [
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
        /incomplete response/i,
      ],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(browser())
          .mockResolvedValueOnce(sse(event)),
      );
      await expect(
        research(
          'Summarize https://example.com',
          [],
          chatgptConfig,
          signal,
          () => {},
        ),
      ).rejects.toThrow(expected);
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(browser())
        .mockResolvedValueOnce(
          sse({ type: 'response.output_text.delta', delta: 'partial only' }),
        ),
    );
    await expect(
      research(
        'Summarize https://example.com',
        [],
        chatgptConfig,
        signal,
        () => {},
      ),
    ).rejects.toThrow(/ended before completion/i);

    const abortController = new AbortController();
    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/browse')) return browser();
        responseStarted();
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true },
              );
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }),
    );
    const aborted = research(
      'Summarize https://example.com',
      [],
      chatgptConfig,
      abortController.signal,
      () => {},
    );
    await started;
    abortController.abort();
    await expect(aborted).rejects.toThrow(/abort/i);
  });
});
