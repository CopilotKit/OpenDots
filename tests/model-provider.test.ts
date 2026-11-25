import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { EventType } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { checkModelEndpoint } from '../src/server/model-check.js';
import { Platform } from '../src/server/platform.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  INTELLIGENCE_KEY_MISSING_LABEL,
  modelConfigFromEnv,
  OLLAMA_PLACEHOLDER_API_KEY,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// A local stand-in for Ollama's OpenAI-compatible /v1/models endpoint.
async function ollamaFixture(
  respond: (res: import('node:http').ServerResponse) => void,
) {
  const requests: { url?: string; authorization?: string }[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  return { requests, baseUrl: `http://127.0.0.1:${port}/v1` };
}
const models =
  (...ids: string[]) =>
  (res: import('node:http').ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: 'library' })),
      }),
    );
  };
const ollama = (baseUrl: string, model?: string) => ({
  modelProvider: 'ollama' as const,
  apiKey: OLLAMA_PLACEHOLDER_API_KEY,
  model,
  baseUrl,
});
const platformConfig: PlatformConfig = {
  intelligenceKey: 'fixture',
  baseUrl: '',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};

it('keeps the OpenAI settings unchanged when no provider is selected', () => {
  expect(modelConfigFromEnv({})).toEqual({
    modelProvider: 'openai',
    apiKey: undefined,
    model: undefined,
    baseUrl: 'https://api.openai.com/v1',
  });
  expect(
    modelConfigFromEnv({
      MODEL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-fixture',
      OPENAI_MODEL: 'gpt-fixture',
      OPENAI_BASE_URL: 'https://proxy.example/v1',
      OLLAMA_MODEL: 'ignored',
    }),
  ).toEqual({
    modelProvider: 'openai',
    apiKey: 'sk-fixture',
    model: 'gpt-fixture',
    baseUrl: 'https://proxy.example/v1',
  });
});

it('selects Ollama without an API key and never forwards the OpenAI key', () => {
  expect(
    modelConfigFromEnv({
      MODEL_PROVIDER: ' Ollama ',
      OLLAMA_MODEL: ' llama3.2 ',
      OPENAI_API_KEY: 'sk-must-stay-with-openai',
      OPENAI_MODEL: 'gpt-fixture',
    }),
  ).toEqual({
    modelProvider: 'ollama',
    apiKey: OLLAMA_PLACEHOLDER_API_KEY,
    model: 'llama3.2',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  });
  expect(DEFAULT_OLLAMA_BASE_URL).toBe('http://localhost:11434/v1');
  expect(
    modelConfigFromEnv({ MODEL_PROVIDER: 'ollama', OLLAMA_MODEL: '  ' }).model,
  ).toBeUndefined();
});

it('normalizes Ollama base URLs and rejects unusable ones', () => {
  const baseUrl = (OLLAMA_BASE_URL: string) =>
    modelConfigFromEnv({ MODEL_PROVIDER: 'ollama', OLLAMA_BASE_URL }).baseUrl;
  expect(baseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
  expect(baseUrl('http://gpu-box:11434/v1/')).toBe('http://gpu-box:11434/v1');
  expect(baseUrl('https://ollama.example/proxy/v1')).toBe(
    'https://ollama.example/proxy/v1',
  );
  for (const value of [
    'localhost:11434',
    'ftp://localhost:11434/v1',
    'not a url',
    'http://user:secret@localhost:11434/v1',
  ]) {
    expect(() => baseUrl(value)).toThrow(/^OLLAMA_BASE_URL must be/);
    try {
      baseUrl(value);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  }
  expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'anthropic' })).toThrow(
    'MODEL_PROVIDER must be "openai" or "ollama".',
  );
});

it('reports Ollama setup without requiring OPENAI_API_KEY', () => {
  const ready = setupStatus({
    ...platformConfig,
    ...modelConfigFromEnv({ MODEL_PROVIDER: 'ollama', OLLAMA_MODEL: 'qwen3' }),
  });
  expect(ready).toMatchObject({
    model: true,
    modelProvider: 'ollama',
    modelBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    missing: [],
  });
  expect(
    setupStatus({
      ...platformConfig,
      intelligenceKey: undefined,
      ...modelConfigFromEnv({ MODEL_PROVIDER: 'ollama' }),
    }),
  ).toMatchObject({
    model: false,
    missing: [INTELLIGENCE_KEY_MISSING_LABEL, 'OLLAMA_MODEL'],
  });
  const openai = setupStatus({
    ...platformConfig,
    ...modelConfigFromEnv({ OPENAI_BASE_URL: 'https://private.example/v1' }),
  });
  expect(openai).toMatchObject({
    model: false,
    modelProvider: 'openai',
    missing: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  });
  expect(openai).not.toHaveProperty('modelBaseUrl');
});

it('confirms the configured model and offers only the other models', async () => {
  const server = await ollamaFixture(models('qwen3:4b', 'llama3.2:latest'));
  expect(await checkModelEndpoint(ollama(server.baseUrl, 'llama3.2'))).toEqual({
    ok: true,
    provider: 'ollama',
    models: ['qwen3:4b'],
    message: 'Ollama is running and has llama3.2.',
  });
  expect(server.requests).toEqual([
    {
      url: '/v1/models',
      authorization: `Bearer ${OLLAMA_PLACEHOLDER_API_KEY}`,
    },
  ]);
  const only = await ollamaFixture(models('llama3.2:1b'));
  expect(
    await checkModelEndpoint(ollama(only.baseUrl, 'llama3.2:1b')),
  ).toMatchObject({ ok: true, models: [] });
});

it('explains a missing, unpulled, or absent Ollama model with one next step', async () => {
  const server = await ollamaFixture(models('llama3.2:latest'));
  expect(await checkModelEndpoint(ollama(server.baseUrl))).toEqual({
    ok: false,
    provider: 'ollama',
    models: ['llama3.2:latest'],
    message: "OLLAMA_MODEL isn't set.",
    hint: 'Set it to an available model, then restart.',
  });
  expect(await checkModelEndpoint(ollama(server.baseUrl, 'qwen3:4b'))).toEqual({
    ok: false,
    provider: 'ollama',
    models: ['llama3.2:latest'],
    message: "Ollama doesn't have qwen3:4b yet.",
    hint: 'Run `ollama pull qwen3:4b`, then check again.',
  });
  const empty = await ollamaFixture(models());
  expect(await checkModelEndpoint(ollama(empty.baseUrl, 'llama3.2'))).toEqual({
    ok: false,
    provider: 'ollama',
    models: [],
    message: 'Ollama has no models yet.',
    hint: 'Run `ollama pull llama3.2`, then set `OLLAMA_MODEL` and restart.',
  });
});

it('reports clearly when Ollama is not running or is not OpenAI-compatible', async () => {
  const stopped = await ollamaFixture(models());
  await cleanup.pop()!();
  expect(await checkModelEndpoint(ollama(stopped.baseUrl, 'llama3.2'))).toEqual(
    {
      ok: false,
      provider: 'ollama',
      models: [],
      message: `Ollama isn't running at ${stopped.baseUrl}.`,
      hint: 'Start it (open the Ollama app or run `ollama serve`), then check again.',
    },
  );
  const notFound = await ollamaFixture((res) => {
    res.statusCode = 404;
    res.end('404 page not found');
  });
  expect(
    await checkModelEndpoint(ollama(notFound.baseUrl, 'llama3.2')),
  ).toMatchObject({
    ok: false,
    message: `Ollama at ${notFound.baseUrl} answered HTTP 404.`,
    hint: "Point `OLLAMA_BASE_URL` at Ollama's `/v1` endpoint.",
  });
  const html = await ollamaFixture((res) => res.end('<html>proxy</html>'));
  expect(
    await checkModelEndpoint(ollama(html.baseUrl, 'llama3.2')),
  ).toMatchObject({
    ok: false,
    message: `${html.baseUrl} didn't return a model list.`,
  });
});

it('does not call the OpenAI endpoint without a key or report the key back', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(
    await checkModelEndpoint(
      { modelProvider: 'openai', model: 'gpt', baseUrl: 'https://x.invalid' },
      fetchImpl,
    ),
  ).toMatchObject({ ok: false, provider: 'openai' });
  expect(fetchImpl).not.toHaveBeenCalled();
  fetchImpl.mockResolvedValue(new Response('{}', { status: 401 }));
  const rejected = await checkModelEndpoint(
    {
      modelProvider: 'openai',
      apiKey: 'sk-secret',
      model: 'gpt',
      baseUrl: 'https://x.invalid/v1/',
    },
    fetchImpl,
  );
  expect(fetchImpl.mock.calls[0][0]).toBe('https://x.invalid/v1/models');
  expect(rejected.message).toBe('The model API rejected the API key.');
  expect(JSON.stringify(rejected)).not.toContain('sk-secret');
});

it('serves the model check only to the owner', async () => {
  const server = await ollamaFixture(models('llama3.2:latest'));
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = { mode: 'live' as const, baseUrl: server.baseUrl };
  const platform = new Platform(store, workspace, {
    ...platformConfig,
    intelligenceKey: undefined,
    ...ollama(server.baseUrl, 'llama3.2'),
  });
  const ownerToken = 'owner-token-with-24-characters';
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  expect((await app.request('/api/setup/model')).status).toBe(401);
  expect(server.requests).toHaveLength(0);
  const response = await app.request('/api/setup/model', {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    provider: 'ollama',
  });
  const state = await app.request('/api/workspace', {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect((await state.json()).setup).toMatchObject({
    model: true,
    modelProvider: 'ollama',
    modelBaseUrl: server.baseUrl,
    missing: [INTELLIGENCE_KEY_MISSING_LABEL],
  });
});

it('runs a Dot turn through Ollama chat completions with the placeholder key', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Ollama');
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Hello from Ollama.' }),
    );
  const agent = new DotAgent(
    store,
    workspace,
    {
      ...platformConfig,
      ...modelConfigFromEnv({
        MODEL_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'llama3.2',
        OPENAI_API_KEY: 'sk-must-stay-with-openai',
      }),
    },
    dot.id,
  );
  const events = await lastValueFrom(
    agent
      .run({
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'Hello' }],
        tools: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: 'Hello from Ollama.',
      }),
    ]),
  );
  const [url, init] = network.mock.calls[0];
  expect(String(url)).toBe('http://localhost:11434/v1/chat/completions');
  expect(new Headers(init?.headers).get('authorization')).toBe(
    `Bearer ${OLLAMA_PLACEHOLDER_API_KEY}`,
  );
  expect(JSON.parse(String(init?.body)).model).toBe('llama3.2');
});
