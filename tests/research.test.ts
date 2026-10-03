import { afterEach, describe, expect, it, vi } from 'vitest';
import { configured, research, type Config } from '../src/server/research.js';
const signal = new AbortController().signal;
const config: Config = {
  mode: 'live',
  webSearchProvider: 'browser',
  apiKey: 'secret',
  model: 'test-model',
  baseUrl: 'https://model.example/v1',
  browserUrl: 'http://browser:4311',
  browserSecret: 'browser-secret',
};
afterEach(() => vi.unstubAllGlobals());
describe('research adapters', () => {
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
  it.each(['claude-code', 'codex', 'chatgpt'])(
    'rejects %s before source or model requests',
    async (provider) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const selected = { ...config, provider };
      expect(configured(selected)).toBe(false);
      await expect(
        research('Read https://example.com', [], selected, signal, () => {}),
      ).rejects.toThrow(/Research briefs need an HTTPS model/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { provider: 'typo', expected: 'MODEL_PROVIDER' },
    {
      provider: 'anthropic',
      expected: 'ANTHROPIC_API_KEY and ANTHROPIC_MODEL',
    },
    { provider: 'cline-pass', expected: 'CLINE_API_KEY and CLINE_MODEL' },
    {
      provider: 'openai',
      apiKey: ' ',
      expected: 'OPENAI_API_KEY and OPENAI_MODEL',
    },
  ])(
    'preserves actionable selected-provider failures for $provider',
    async ({ expected, ...selection }) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        research(
          'Read https://example.com',
          [],
          { ...config, ...selection },
          signal,
          () => {},
        ),
      ).rejects.toThrow(expected);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
