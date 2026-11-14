import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

interface CapturedEvent {
  url: string;
  headers: Record<string, string>;
  body: {
    event: string;
    global_properties: {
      accessibility_title?: string;
      sampleRate: number;
      installation_id?: string;
      opendots_distribution?: string;
    };
  };
}

async function captureRuntime() {
  const keys = [
    'DO_NOT_TRACK',
    'COPILOTKIT_TELEMETRY_DISABLED',
    'COPILOTKIT_TELEMETRY_SAMPLE_RATE',
    'COPILOTKIT_LICENSE_TOKEN',
    'COPILOTKIT_TELEMETRY_URL',
    'CPK_TELEMETRY_ID',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests: CapturedEvent[] = [];
  for (const key of keys) delete process.env[key];
  process.env.CPK_TELEMETRY_ID = 'test-project-identity';
  globalThis.fetch = async (url, options) => {
    const body =
      typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    requests.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
      body,
    });
    return new Response('{"ok":true}', { status: 202 });
  };
  const [{ Platform }, { Store }, { WorkspaceStore }] = await Promise.all([
    import('../src/server/platform.js'),
    import('../src/server/store.js'),
    import('../src/server/workspace.js'),
  ]);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
  try {
    const platform = new Platform(store, workspace, {
      intelligenceKey: 'test-project-key-never-sent',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    await platform.handle(new Request('http://localhost/api/copilotkit/info'));
    const dot = workspace.dots()[0];
    workspace.bindThread('fixture-thread', dot.id, 'Fixture');
    const response = await platform.handle(
      new Request('http://localhost/api/copilotkit/agent/' + dot.id + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: 'fixture-thread',
          messages: 'invalid',
        }),
      }),
    );
    if (response.status !== 400)
      throw new Error('Expected SDK body validation failure');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    store.close();
    workspace.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  return requests;
}

// The real SDK import is intentionally expensive on Windows. Capture it once
// during module collection, without a nested Node+tsx process. SetupTelemetry's
// unit tests cover true/1 opt-outs, sample-rate zero, and fallback identity.
const runtimeEvents = await captureRuntime();

it('sends OpenDots runtime metadata with CLI identity and without the project key', async () => {
  const events = runtimeEvents.filter(
    (event) => event.url === 'https://telemetry.copilotkit.ai/ingest',
  );
  const created = events.find(
    (event) => event.body.event === 'oss.runtime.instance_created',
  );
  expect(created).toBeDefined();
  expect(created?.url).toBe('https://telemetry.copilotkit.ai/ingest');
  expect(created?.headers['X-CopilotKit-Telemetry-Id']).toBe(
    'test-project-identity',
  );
  expect(created?.body.global_properties.accessibility_title).toBe('OpenDots');
  expect(created?.body.global_properties.sampleRate).toBe(1);
  const request = events.find(
    (event) => event.body.event === 'oss.runtime.copilot_request_created',
  );
  expect(request?.body.global_properties.accessibility_title).toBe('OpenDots');
  expect(request?.headers['X-CopilotKit-Telemetry-Id']).toBe(
    'test-project-identity',
  );
  expect(JSON.stringify(events)).not.toContain('test-project-key-never-sent');
  expect(
    events.some((event) => event.body.event === 'intelligence_signup'),
  ).toBe(false);
});

it('forwards the CLI identity and both opt-outs into the Docker app', async () => {
  const compose = await readFile(
    new URL('../compose.yml', import.meta.url),
    'utf8',
  );
  expect(compose).toContain('CPK_TELEMETRY_ID: ${CPK_TELEMETRY_ID:-}');
  expect(compose).toContain('DO_NOT_TRACK: ${DO_NOT_TRACK:-0}');
  expect(compose).toContain(
    'COPILOTKIT_TELEMETRY_DISABLED: ${COPILOTKIT_TELEMETRY_DISABLED:-false}',
  );
});
