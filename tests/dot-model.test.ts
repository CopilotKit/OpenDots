import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, type StreamChunk } from '@tanstack/ai';
import {
  createDotModel,
  dotModelSettingsFromEnv,
  type DotModelSettings,
  type DotReasoningEffort,
} from '../src/server/dot-model.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { completion } from './fixtures/model-stream.js';
import { responses } from './fixtures/responses-stream.js';

afterEach(() => vi.restoreAllMocks());

describe('dotModelSettingsFromEnv', () => {
  it.each([
    {},
    { DOT_MODEL_API: '', DOT_MAX_OUTPUT_TOKENS: '' },
    { DOT_MODEL_API: ' \t\n', DOT_MAX_OUTPUT_TOKENS: ' \t\n' },
    { DOT_MODEL_API: 'chat-completions' },
    { DOT_MAX_OUTPUT_TOKENS: '2200' },
    { DOT_REASONING_EFFORT: '' },
    { DOT_REASONING_EFFORT: ' \t\n' },
  ])('uses compatible defaults for %j', (env) => {
    expect(dotModelSettingsFromEnv(env)).toEqual({
      dotModelApi: 'chat-completions',
      dotMaxOutputTokens: 2200,
    });
  });

  it.each(['chat-completions', 'responses'])(
    'trims %s and the token budget',
    (api) => {
      expect(
        dotModelSettingsFromEnv({
          DOT_MODEL_API: ` \t${api}\n`,
          DOT_MAX_OUTPUT_TOKENS: ' \t4096\n',
        }),
      ).toEqual({ dotModelApi: api, dotMaxOutputTokens: 4096 });
    },
  );

  it.each(['1', '00042', String(Number.MAX_SAFE_INTEGER)])(
    'accepts a digits-only positive safe budget %s',
    (budget) => {
      expect(
        dotModelSettingsFromEnv({ DOT_MAX_OUTPUT_TOKENS: budget })
          .dotMaxOutputTokens,
      ).toBe(Number(budget));
    },
  );

  it.each(['Responses', 'CHAT-COMPLETIONS', 'unknown', 'responses-v2'])(
    'rejects an unknown or case-mismatched API %s with its variable name',
    (api) => {
      expect(() => dotModelSettingsFromEnv({ DOT_MODEL_API: api })).toThrow(
        /DOT_MODEL_API/,
      );
    },
  );

  it.each([
    '0',
    '-1',
    '1.5',
    '2e3',
    'NaN',
    'Infinity',
    String(Number.MAX_SAFE_INTEGER + 1),
    '+1',
    '0x10',
    '1 0',
  ])('rejects invalid budget %s with its variable name', (budget) => {
    expect(() =>
      dotModelSettingsFromEnv({ DOT_MAX_OUTPUT_TOKENS: budget }),
    ).toThrow(/DOT_MAX_OUTPUT_TOKENS/);
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts and trims the native reasoning effort %s',
    (effort) => {
      expect(
        dotModelSettingsFromEnv({ DOT_REASONING_EFFORT: ` \t${effort}\n` }),
      ).toEqual({
        dotModelApi: 'chat-completions',
        dotMaxOutputTokens: 2200,
        dotReasoningEffort: effort,
      });
    },
  );

  it.each(['None', 'MEDIUM', 'default', 'unknown'])(
    'rejects unknown or case-mismatched reasoning effort %s',
    (effort) => {
      expect(() =>
        dotModelSettingsFromEnv({ DOT_REASONING_EFFORT: effort }),
      ).toThrow(/DOT_REASONING_EFFORT/);
    },
  );

  it.each(['DOT_MODEL_API', 'DOT_MAX_OUTPUT_TOKENS', 'DOT_REASONING_EFFORT'])(
    'does not echo sensitive values in %s validation errors',
    (variable) => {
      expect(() =>
        dotModelSettingsFromEnv({
          [variable]: 'private-setting-fixture',
          OPENAI_MODEL: 'private-model-fixture',
          OPENAI_API_KEY: 'private-key-fixture',
        }),
      ).toThrow(
        expect.objectContaining({
          message: expect.not.stringMatching(/private-.*-fixture/),
        }),
      );
    },
  );
});

// Existing consumers can omit the optional model settings.
const config: PlatformConfig = {
  model: 'custom-model',
  apiKey: 'fixture-key',
  baseUrl: 'https://unused.invalid/v1',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};

describe('createDotModel', () => {
  it.each([
    {
      label: 'legacy defaults',
      settings: {},
      api: 'chat-completions',
      budget: 2200,
    },
    {
      label: 'explicit Chat Completions',
      settings: { dotModelApi: 'chat-completions', dotMaxOutputTokens: 640 },
      api: 'chat-completions',
      budget: 640,
    },
    {
      label: 'Responses with a custom budget',
      settings: { dotModelApi: 'responses', dotMaxOutputTokens: 4096 },
      api: 'responses',
      budget: 4096,
    },
    {
      label: 'Responses with the default budget',
      settings: { dotModelApi: 'responses' },
      api: 'responses',
      budget: 2200,
    },
  ] satisfies {
    label: string;
    settings: DotModelSettings;
    api: string;
    budget: number;
  }[])(
    'sends the correct wire request for $label',
    async ({ settings, api, budget }) => {
      const text = 'Offline model reply.';
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fixture request'))
        .mockResolvedValueOnce(
          api === 'responses'
            ? responses({ text })
            : completion({ content: text }),
        );
      const { adapter, modelOptions } = createDotModel({
        ...config,
        ...settings,
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of chat({
        adapter,
        modelOptions,
        messages: [{ role: 'user', content: 'Hello.' }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT', delta: text }),
      );
      expect(network).toHaveBeenCalledTimes(1);
      const [url, init] = network.mock.calls[0];
      expect(String(url)).toBe(
        `${config.baseUrl}/${api === 'responses' ? 'responses' : 'chat/completions'}`,
      );
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${config.apiKey}`,
      );
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: config.model, stream: true });
      if (api === 'responses') {
        expect(body).toMatchObject({
          max_output_tokens: budget,
          store: false,
          include: ['reasoning.encrypted_content'],
        });
        expect(body).not.toHaveProperty('max_completion_tokens');
      } else {
        expect(body).toHaveProperty('max_completion_tokens', budget);
        for (const key of ['max_output_tokens', 'store', 'include']) {
          expect(body).not.toHaveProperty(key);
        }
      }
      for (const key of [
        'max_tokens',
        'reasoning_effort',
        'reasoning',
        'previous_response_id',
        'conversation',
      ]) {
        expect(body).not.toHaveProperty(key);
      }
    },
  );

  it.each([
    { api: 'chat-completions', effort: 'medium' },
    { api: 'responses', effort: 'medium' },
    { api: 'chat-completions', effort: 'none' },
    { api: 'responses', effort: 'none' },
  ] satisfies {
    api: DotModelSettings['dotModelApi'];
    effort: DotReasoningEffort;
  }[])(
    'sends only the native $api reasoning option when $effort is explicit',
    async ({ api, effort }) => {
      const text = 'Explicit effort reply.';
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fixture request'))
        .mockResolvedValueOnce(
          api === 'responses'
            ? responses({ text })
            : completion({ content: text }),
        );
      const { adapter, modelOptions } = createDotModel({
        ...config,
        dotModelApi: api,
        dotMaxOutputTokens: 8192,
        dotReasoningEffort: effort,
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of chat({
        adapter,
        modelOptions,
        messages: [{ role: 'user', content: 'Hello.' }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT', delta: text }),
      );
      expect(network).toHaveBeenCalledTimes(1);
      const [url, init] = network.mock.calls[0];
      expect(String(url)).toBe(
        `${config.baseUrl}/${api === 'responses' ? 'responses' : 'chat/completions'}`,
      );
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      if (api === 'responses') {
        expect(body).toMatchObject({
          reasoning: { effort },
          max_output_tokens: 8192,
          store: false,
          include: ['reasoning.encrypted_content'],
        });
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('max_completion_tokens');
      } else {
        expect(body).toMatchObject({
          reasoning_effort: effort,
          max_completion_tokens: 8192,
        });
        for (const key of [
          'reasoning',
          'max_output_tokens',
          'store',
          'include',
        ]) {
          expect(body).not.toHaveProperty(key);
        }
      }
    },
  );

  it.each(['', ' ', 'None', 'unknown', null, 1, 'private-effort-fixture'])(
    'rejects invalid programmatic effort %j without fetching or echoing secrets',
    (effort) => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fixture request'));
      const create = () =>
        createDotModel({
          ...config,
          model: 'private-model-fixture',
          apiKey: 'private-key-fixture',
          dotReasoningEffort: effort as DotReasoningEffort,
        });
      expect(create).toThrow(/DOT_REASONING_EFFORT/);
      expect(create).toThrow(
        expect.objectContaining({
          message: expect.not.stringMatching(/private-.*-fixture/),
        }),
      );
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each([
    { model: undefined },
    { model: '' },
    { apiKey: undefined },
    { apiKey: '' },
  ])('rejects missing model configuration %j without fetching', (missing) => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected fixture request'));
    expect(() => createDotModel({ ...config, ...missing })).toThrow(
      'Model configuration is required.',
    );
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '2200' as unknown as number,
    null as unknown as number,
  ])(
    'rejects an invalid programmatic budget %s without fetching',
    (dotMaxOutputTokens) => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fixture request'));
      expect(() => createDotModel({ ...config, dotMaxOutputTokens })).toThrow(
        /DOT_MAX_OUTPUT_TOKENS/,
      );
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each(['Responses', 'unknown', ''])(
    'rejects a programmatic API %j without fetching',
    (api) => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fixture request'));
      expect(() =>
        createDotModel({
          ...config,
          dotModelApi: api as DotModelSettings['dotModelApi'],
        }),
      ).toThrow(/DOT_MODEL_API/);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it('uses the existing base URL fallback and retries at most once', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('Fixture failure', { status: 500 }),
      );
    const { adapter, modelOptions } = createDotModel({
      ...config,
      baseUrl: undefined as unknown as string,
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter,
      modelOptions,
      messages: [{ role: 'user', content: 'Hello.' }],
      debug: false,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'RUN_ERROR',
        message: '500 Fixture failure',
      }),
    );
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ type: 'RUN_FINISHED' }),
    );
    expect(network).toHaveBeenCalledTimes(2);
    for (const [url] of network.mock.calls) {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    }
  });
});
