import { afterEach, expect, it, vi } from 'vitest';
import { chat } from '@tanstack/ai';
import { httpAdapterFor } from '../src/server/model-adapters.js';
import { resolveModel } from '../src/server/models.js';
import { completion } from './fixtures/model-stream.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    selection: {
      provider: 'openai',
      apiKey: 'fixture-openai',
      model: 'fixture-model',
    },
    url: 'https://api.openai.com/v1/chat/completions',
    key: 'fixture-openai',
    anthropic: false,
  },
  {
    selection: {
      provider: 'custom',
      apiKey: 'fixture-custom',
      model: 'fixture-model',
      baseUrl: 'https://custom.invalid/v1',
    },
    url: 'https://custom.invalid/v1/chat/completions',
    key: 'fixture-custom',
    anthropic: false,
  },
  {
    selection: {
      provider: 'cline-pass',
      clineKey: 'fixture-cline',
      clineModel: 'fixture-model',
    },
    url: 'https://api.cline.bot/api/v1/chat/completions',
    key: 'fixture-cline',
    anthropic: false,
  },
  {
    selection: {
      provider: 'anthropic',
      anthropicKey: 'fixture-anthropic',
      anthropicModel: 'fixture-model',
    },
    url: 'https://api.anthropic.com/v1/chat/completions',
    key: 'fixture-anthropic',
    anthropic: true,
  },
])(
  'sends the $selection.provider request with its endpoint and authentication',
  async ({ selection, url, key, anthropic }) => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        completion({ role: 'assistant', content: 'Fixture response.' }),
      );
    const stream = chat({
      adapter: httpAdapterFor(resolveModel(selection)),
      messages: [{ role: 'user', content: 'Fixture prompt.' }],
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0][0])).toBe(url);
    const headers = new Headers(network.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe(
      anthropic ? null : `Bearer ${key}`,
    );
    expect(headers.get('x-api-key')).toBe(anthropic ? key : null);
    expect(headers.get('anthropic-version')).toBe(
      anthropic ? '2023-06-01' : null,
    );
    expect(JSON.parse(String(network.mock.calls[0][1]?.body)).model).toBe(
      'fixture-model',
    );
  },
);
