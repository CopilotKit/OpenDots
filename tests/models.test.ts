import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG,
  chatCompletionsRequest,
  isRetired,
  parseProvider,
  resolveModel,
  type ModelSelection,
} from '../src/server/models.js';

describe('model configuration examples', () => {
  it('includes each configured provider family', () => {
    const ids = MODEL_CATALOG.map((entry) => entry.id);
    for (const id of [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'gpt-6.1-sol',
      'cline-pass/qwen3.7-max',
    ])
      expect(ids).toContain(id);
  });
  it('refuses retired models with an actionable error', () => {
    const retired = MODEL_CATALOG.find((entry) => entry.id === 'gpt-5.5')!;
    expect(isRetired(retired, new Date('2026-10-15T00:00:00Z'))).toBe(true);
    expect(() =>
      resolveModel(
        {
          provider: 'openai',
          apiKey: 'k',
          model: 'gpt-5.5',
          baseUrl: 'https://x',
        },
        new Date('2026-10-15T00:00:00Z'),
      ),
    ).toThrow(/retired/);
  });
  it.each([
    { provider: 'openai', apiKey: 'fixture', model: 'gpt-5.5' },
    { provider: 'codex', codexModel: 'gpt-5.5' },
    { provider: 'custom', apiKey: 'fixture', model: 'gpt-5.5' },
    {
      provider: 'custom',
      apiKey: 'fixture',
      model: 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1/',
    },
  ])(
    'retires OpenAI-backed $provider only after all of October 14 UTC',
    (selection) => {
      expect(
        resolveModel(selection, new Date('2026-10-14T23:59:59.999Z')).model,
      ).toBe('gpt-5.5');
      expect(() =>
        resolveModel(selection, new Date('2026-10-15T00:00:00Z')),
      ).toThrow(/2026-10-15T00:00:00Z/);
    },
  );
  it('lets an explicit custom endpoint own identically named models', () => {
    expect(
      resolveModel(
        {
          provider: 'custom',
          apiKey: 'fixture',
          model: 'gpt-5.5',
          baseUrl: 'https://custom.example/v1',
        },
        new Date('2026-10-15T00:00:00Z'),
      ).model,
    ).toBe('gpt-5.5');
    expect(
      resolveModel(
        { provider: 'openai', apiKey: 'fixture', model: 'claude-haiku-4-5' },
        new Date('2030-01-01T00:00:00Z'),
      ).model,
    ).toBe('claude-haiku-4-5');
  });
});

describe('provider parsing', () => {
  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['cline-pass', 'cline-pass'],
    ['claude', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['chatgpt', 'codex'],
    ['custom', 'custom'],
    [' CLAUDE_CODE ', 'claude-code'],
    ['clinepass', 'cline-pass'],
    ['cline_pass', 'cline-pass'],
    ['claude-subscription', 'claude-code'],
    ['codex-subscription', 'codex'],
    ['openai-codex', 'codex'],
    ['', 'openai'],
  ])('parses %s', (input, expected) => {
    expect(parseProvider(input)).toBe(expected);
  });
  it('rejects unknown providers', () => {
    expect(() => parseProvider('nope')).toThrow(/MODEL_PROVIDER/);
    expect(() =>
      resolveModel({ provider: 'nope', apiKey: 'fixture', model: 'fixture' }),
    ).toThrow(/MODEL_PROVIDER/);
  });
});

describe('resolveModel', () => {
  it('resolves Anthropic + Cline Pass HTTPS slots', () => {
    const anthropic = resolveModel({
      provider: 'anthropic',
      anthropicKey: 'a',
      anthropicModel: 'claude-sonnet-5-5',
    });
    expect(anthropic.harness).toBe(false);
    const cline = resolveModel({
      provider: 'cline-pass',
      clineKey: 'c',
      clineModel: 'cline-pass/qwen3.7-max',
    });
    expect(cline).toMatchObject({
      kind: 'http',
      baseUrl: 'https://api.cline.bot/api/v1',
    });
    const request = chatCompletionsRequest(cline, { messages: [] });
    expect(request.headers.Authorization).toBe('Bearer c');
  });
  it('resolves Claude/Codex subscription harnesses without keys', () => {
    const claude = resolveModel({
      provider: 'claude-code',
      claudeAuthMode: 'host',
      claudeModel: 'claude-sonnet-5-5',
    });
    expect(claude).toMatchObject({
      harness: true,
      authMode: 'host',
      permissionMode: 'acceptEdits',
    });
    const codex = resolveModel({
      provider: 'codex',
      codexModel: 'gpt-5.2-codex',
    });
    expect(codex.harness).toBe(true);
    // Harness models never go over HTTPS.
    expect(() => chatCompletionsRequest(claude, { messages: [] })).toThrow(
      /harness/,
    );
  });
  it('throws actionable errors when slots are incomplete', () => {
    expect(() =>
      resolveModel({ provider: 'anthropic', anthropicKey: 'a' }),
    ).toThrow(/ANTHROPIC_MODEL/);
    expect(() =>
      resolveModel({ provider: 'claude-code', claudeAuthMode: 'host' }),
    ).toThrow(/CLAUDE_MODEL/);
  });
  it('keeps Anthropic headers off the OpenAI-compatible path', () => {
    const openai = resolveModel({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-6.1-sol',
      baseUrl: 'https://api.openai.com/v1',
    });
    const viaOpenAI = chatCompletionsRequest(openai, { messages: [] });
    expect(viaOpenAI.headers.Authorization).toBe('Bearer k');
    expect(viaOpenAI.headers['anthropic-version']).toBeUndefined();
    const anthropic = resolveModel({
      provider: 'anthropic',
      anthropicKey: 'a',
      anthropicModel: 'claude-sonnet-5-5',
    });
    const viaAnthropic = chatCompletionsRequest(anthropic, { messages: [] });
    expect(viaAnthropic.headers['x-api-key']).toBe('a');
    expect(viaAnthropic.headers['anthropic-version']).toBe('2023-06-01');
    expect(viaAnthropic.url).toBe(
      'https://api.anthropic.com/v1/chat/completions',
    );
  });
  it('preserves the legacy OpenAI configuration and trims values', () => {
    expect(
      resolveModel({
        apiKey: ' fixture ',
        model: ' fixture-model ',
        baseUrl: ' ',
      }),
    ).toEqual({
      kind: 'http',
      provider: 'openai',
      harness: false,
      apiKey: 'fixture',
      model: 'fixture-model',
      baseUrl: 'https://api.openai.com/v1',
    });
  });
  it.each<ModelSelection>([
    { provider: 'openai', apiKey: ' ', model: 'fixture' },
    { provider: 'openai', apiKey: 'fixture', model: ' ' },
    { provider: 'anthropic', anthropicKey: ' ', anthropicModel: 'fixture' },
    { provider: 'cline-pass', clineKey: 'fixture', clineModel: ' ' },
    { provider: 'claude-code', claudeModel: ' ' },
    { provider: 'codex', codexModel: ' ' },
  ])('rejects a blank required slot for $provider', (selection) => {
    expect(() => resolveModel(selection)).toThrow(/Set /);
  });
  it.each(['api-key', 'invalid', ''])(
    'rejects unsupported subscription authentication %s',
    (mode) => {
      expect(() =>
        resolveModel({
          provider: 'claude-code',
          claudeModel: 'fixture',
          claudeAuthMode: mode,
        }),
      ).toThrow(/CLAUDE_AUTH_MODE must be host/);
      expect(() =>
        resolveModel({
          provider: 'codex',
          codexModel: 'fixture',
          codexAuthMode: mode,
        }),
      ).toThrow(/CODEX_AUTH_MODE must be host/);
    },
  );
  it('validates permissions and places default subprocess work in ignored data', () => {
    expect(() =>
      resolveModel({
        provider: 'claude-code',
        claudeModel: 'fixture',
        claudePermissionMode: 'invented',
      }),
    ).toThrow(/CLAUDE_PERMISSION_MODE/);
    expect(() =>
      resolveModel({
        provider: 'claude-code',
        claudeModel: 'fixture',
        claudePermissionMode: 'dontAsk',
      }),
    ).toThrow(/CLAUDE_PERMISSION_MODE/);
    expect(
      resolveModel({
        provider: 'claude-code',
        claudeModel: 'fixture',
        claudeCwd: ' ',
      }),
    ).toMatchObject({
      cwd: resolve('.opendots/harnesses/claude-code'),
      permissionMode: 'acceptEdits',
    });
    expect(
      resolveModel({
        provider: 'codex',
        codexModel: 'fixture',
        codexCwd: 'relative-fixture',
      }),
    ).toMatchObject({ cwd: resolve('relative-fixture') });
  });
  it('resolves the harness slot through the platform config', async () => {
    const adapters = await import('../src/server/model-adapters.js');
    const resolved = adapters.resolveActiveModel({
      modelProvider: 'claude-code',
      apiKey: undefined,
      model: undefined,
      baseUrl: 'https://api.openai.com/v1',
      anthropicKey: undefined,
      anthropicModel: undefined,
      clineKey: undefined,
      clineModel: undefined,
      claudeAuthMode: 'host',
      claudeModel: 'claude-sonnet-5-5',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    expect(resolved).toMatchObject({ provider: 'claude-code', harness: true });
    expect(() => adapters.httpAdapterFor(resolved)).toThrow(/harness adapter/);
  });
});
