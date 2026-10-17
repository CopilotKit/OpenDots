import { expect, it } from 'vitest';
import { describeModelError, providerName } from '../src/server/model-errors';
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
  modelConfigFromEnv,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config';

it('uses OpenRouter when only OPENROUTER_API_KEY is set', () => {
  expect(modelConfigFromEnv({ OPENROUTER_API_KEY: ' or-key ' })).toEqual({
    apiKey: 'or-key',
    model: DEFAULT_OPENROUTER_MODEL,
    baseUrl: OPENROUTER_BASE_URL,
  });
  expect(
    modelConfigFromEnv({
      OPENROUTER_API_KEY: 'or-key',
      PLOOP_MODEL: 'openai/gpt-5',
    }).model,
  ).toBe('openai/gpt-5');
});

it('keeps an existing OpenAI-compatible setup when OPENAI_API_KEY is set', () => {
  expect(
    modelConfigFromEnv({
      OPENAI_API_KEY: 'sk',
      OPENAI_MODEL: 'gpt-5',
      OPENROUTER_API_KEY: 'or-key',
    }),
  ).toEqual({
    apiKey: 'sk',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
  });
  expect(modelConfigFromEnv({})).toEqual({
    apiKey: undefined,
    model: undefined,
    baseUrl: 'https://api.openai.com/v1',
  });
});

it('names both key options while the model key is missing', () => {
  const status = setupStatus({
    baseUrl: OPENROUTER_BASE_URL,
    model: DEFAULT_OPENROUTER_MODEL,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '/api/copilotkit',
  } as PlatformConfig);
  expect(status.missing).toContain('OPENROUTER_API_KEY (or OPENAI_API_KEY)');
});

it('explains provider failures in plain words without echoing the response', () => {
  const url = OPENROUTER_BASE_URL;
  expect(providerName(url)).toBe('OpenRouter');
  expect(
    describeModelError(
      Object.assign(new Error('secret body'), { status: 401 }),
      url,
    ),
  ).toBe(
    'OpenRouter didn’t accept the API key. Check the key in the server settings.',
  );
  expect(
    describeModelError(new Error('402 Insufficient credits'), url),
  ).toMatch(/out of credits/);
  expect(describeModelError({ statusCode: 404 }, url)).toMatch(/that model/);
  expect(describeModelError(new Error('429 slow down'), url)).toMatch(
    /rate limiting/,
  );
  expect(describeModelError(new Error('503 upstream'), url)).toMatch(
    /on its side/,
  );
  expect(describeModelError(new Error('fetch failed'), url)).toBe(
    'ploop couldn’t reach OpenRouter. Check the internet connection.',
  );
  expect(
    describeModelError(new Error('fetch failed'), 'https://llm.example/v1'),
  ).toBe(
    'ploop couldn’t reach the model provider. Check the internet connection.',
  );
  expect(describeModelError(new Error('Specialist Dot not found.'), url)).toBe(
    undefined,
  );
});
