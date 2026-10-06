import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../src/server/platform.js';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import {
  plainText,
  sendblueConfigFromEnv,
  sendblueProblems,
  splitReply,
  type SendblueConfig,
} from '../src/server/sendblue.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const LINE = '+15550100000';
const OWNER = '+15550100123';
const SECRET = 'fixture-webhook-secret-0123456789';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
  vi.restoreAllMocks();
});

function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
function body(request: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
  });
}
type Sent = {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
};
// A local stand-in for api.sendblue.com that records every send request.
async function sendblueApi() {
  const sent: Sent[] = [];
  const media: string[] = [];
  let respond = (_sent: Sent) =>
    Response.json({ status: 'QUEUED', message_handle: randomUUID() });
  const server: Server = createServer(async (request, response) => {
    if (request.url !== '/api/send-message') {
      media.push(request.url ?? '');
      response.writeHead(404).end();
      return;
    }
    const entry = {
      headers: request.headers,
      body: JSON.parse(await body(request)),
    };
    sent.push(entry);
    const reply = respond(entry);
    if (reply.type === 'error') {
      request.socket.destroy();
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(await reply.text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    sent,
    media,
    respond(next: (sent: Sent) => Response) {
      respond = next;
    },
  };
}
async function fixture(
  options: {
    database?: string;
    sendblue?: Partial<SendblueConfig>;
    config?: Partial<PlatformConfig>;
    api?: Awaited<ReturnType<typeof sendblueApi>>;
  } = {},
) {
  const api = options.api ?? (await sendblueApi());
  const database = options.database ?? ':memory:';
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const port = await freePort();
  const sendblue: SendblueConfig = {
    apiKey: 'fixture-key',
    apiSecret: 'fixture-api-secret',
    fromNumber: LINE,
    webhookSecret: SECRET,
    allowedNumbers: [OWNER],
    webhookHost: '127.0.0.1',
    webhookPort: port,
    apiUrl: `${api.origin}/api/send-message`,
    ...options.sendblue,
  };
  const platform = new Platform(store, workspace, {
    intelligenceKey: 'fixture',
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://example.com',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    sendblue,
    ...options.config,
  });
  // Intelligence and the model are the only fixtures: thread binding,
  // routing, settings and storage are the application's own.
  const createConversation = vi
    .spyOn(platform, 'createConversation')
    .mockImplementation(async (dotId, title) =>
      workspace.bindThread(randomUUID(), dotId, title),
    );
  const turn = vi
    .spyOn(platform, 'turn')
    .mockImplementation(async (_thread, prompt) => `**Noted:** ${prompt}`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await platform.stop();
    store.close();
    workspace.close();
  };
  cleanup.push(stop);
  const post = (
    event: Record<string, unknown> | string,
    headers: Record<string, string> = { 'sb-signing-secret': SECRET },
  ) =>
    fetch(`http://127.0.0.1:${port}/sendblue/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof event === 'string' ? event : JSON.stringify(event),
    });
  return {
    api,
    platform,
    store,
    workspace,
    port,
    turn,
    createConversation,
    post,
    stop,
  };
}
const received = (overrides: Record<string, unknown> = {}) => ({
  accountEmail: 'owner@example.com',
  content: 'Remember the word cobalt',
  is_outbound: false,
  status: 'RECEIVED',
  message_handle: randomUUID(),
  from_number: OWNER,
  number: OWNER,
  to_number: LINE,
  sendblue_number: LINE,
  media_url: '',
  group_id: '',
  service: 'iMessage',
  ...overrides,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it('reads Sendblue settings from the environment and names what is missing', () => {
  expect(sendblueConfigFromEnv({ SENDBLUE_DOT_ID: 'dot' })).toBeUndefined();
  const partial = sendblueConfigFromEnv({
    SENDBLUE_API_KEY: 'key',
    SENDBLUE_WEBHOOK_SECRET: 'short',
    SENDBLUE_ALLOWED_NUMBERS: `${LINE}, 555`,
  })!;
  expect(sendblueProblems(partial)).toEqual([
    'SENDBLUE_API_SECRET',
    'SENDBLUE_FROM_NUMBER (the assigned line in E.164 format)',
    'SENDBLUE_WEBHOOK_SECRET (24 or more characters)',
    'SENDBLUE_ALLOWED_NUMBERS (E.164 numbers other than the assigned line)',
  ]);
  const complete = sendblueConfigFromEnv({
    HOST: '0.0.0.0',
    SENDBLUE_API_KEY: 'key',
    SENDBLUE_API_SECRET: 'secret',
    SENDBLUE_FROM_NUMBER: LINE,
    SENDBLUE_WEBHOOK_SECRET: SECRET,
    SENDBLUE_ALLOWED_NUMBERS: ` ${OWNER} , +15550100124 `,
    SENDBLUE_WEBHOOK_PORT: '4400',
  })!;
  expect(complete).toMatchObject({
    allowedNumbers: [OWNER, '+15550100124'],
    webhookHost: '0.0.0.0',
    webhookPort: 4400,
    apiUrl: 'https://api.sendblue.com/api/send-message',
  });
  expect(sendblueProblems(complete)).toEqual([]);
  expect(
    sendblueProblems({ ...complete, webhookPort: Number('port') }),
  ).toEqual(['SENDBLUE_WEBHOOK_PORT']);
  const base = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://example.com',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  expect(setupStatus(base).sendblue).toBe('not_configured');
  expect(
    setupStatus({ ...base, sendblue: partial }, 'x', false, 'listening')
      .sendblue,
  ).toBe('setup_required');
  expect(
    setupStatus({ ...base, sendblue: complete }, 'x', false, 'listening')
      .sendblue,
  ).toBe('listening');
});

it('answers allowlisted texts in one persistent Dot conversation across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-sendblue-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'opendots.sqlite');
  const first = await fixture({ database });
  await first.platform.start();
  expect(first.platform.setup().sendblue).toBe('listening');

  const opening = received();
  expect((await first.post(opening)).status).toBe(200);
  await vi.waitFor(() => expect(first.api.sent).toHaveLength(1));
  const [thread] = first.workspace.conversations();
  expect(thread).toMatchObject({
    dotId: first.workspace.dots()[0].id,
    title: 'Text message ···0123',
  });
  expect(first.turn).toHaveBeenCalledWith(
    thread.id,
    'Remember the word cobalt',
    expect.any(AbortSignal),
    { opendotsSource: 'sendblue' },
  );
  expect(first.api.sent[0].headers).toMatchObject({
    'sb-api-key-id': 'fixture-key',
    'sb-api-secret-key': 'fixture-api-secret',
  });
  expect(first.api.sent[0].body).toEqual({
    number: OWNER,
    from_number: LINE,
    content: 'Noted: Remember the word cobalt',
  });

  await first.post(received({ content: 'What word did I ask for?' }));
  await vi.waitFor(() => expect(first.api.sent).toHaveLength(2));
  expect(first.turn).toHaveBeenLastCalledWith(
    thread.id,
    'What word did I ask for?',
    expect.any(AbortSignal),
    { opendotsSource: 'sendblue' },
  );
  await first.stop();
  expect(first.platform.setup().sendblue).toBe('stopped');
  await expect(first.post(received())).rejects.toThrow();

  const second = await fixture({ database, api: first.api });
  await second.platform.start();
  // A redelivery of an answered message is not answered again after restart.
  expect((await second.post(opening)).status).toBe(200);
  await second.post(received({ content: 'Still there?' }));
  await vi.waitFor(() => expect(second.api.sent).toHaveLength(3));
  expect(second.turn).toHaveBeenCalledExactlyOnceWith(
    thread.id,
    'Still there?',
    expect.any(AbortSignal),
    { opendotsSource: 'sendblue' },
  );
  expect(second.createConversation).not.toHaveBeenCalled();

  await second.post(received({ content: ' /NEW ' }));
  await vi.waitFor(() => expect(second.api.sent).toHaveLength(4));
  expect(second.api.sent[3].body.content).toBe('Started a new conversation.');
  await second.post(received({ content: 'Fresh start' }));
  await vi.waitFor(() => expect(second.api.sent).toHaveLength(5));
  const fresh = second.workspace.conversations()[0];
  expect(fresh.id).not.toBe(thread.id);
  expect(second.turn).toHaveBeenLastCalledWith(
    fresh.id,
    'Fresh start',
    expect.any(AbortSignal),
    { opendotsSource: 'sendblue' },
  );
});

it('rejects unauthenticated, oversized and malformed callbacks before any turn', async () => {
  const f = await fixture();
  await f.platform.start();
  expect((await f.post(received(), {})).status).toBe(401);
  expect(
    (await f.post(received(), { 'sb-signing-secret': 'wrong' })).status,
  ).toBe(401);
  expect(
    (
      await f.post(received(), {
        'sb-signing-secret': SECRET.replace('fixture', 'imposter'),
      })
    ).status,
  ).toBe(401);
  expect((await f.post(received({ content: 'x'.repeat(70_000) }))).status).toBe(
    413,
  );
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(70_000)));
      controller.close();
    },
  });
  expect(
    (
      await fetch(`http://127.0.0.1:${f.port}/sendblue/webhook`, {
        method: 'POST',
        headers: { 'sb-signing-secret': SECRET },
        body: oversized,
        duplex: 'half',
      } as RequestInit)
    ).status,
  ).toBe(413);
  expect((await f.post('{not json')).status).toBe(400);
  expect((await f.post('[]')).status).toBe(400);
  expect((await f.post(received({ from_number: 15550100123 }))).status).toBe(
    400,
  );
  expect((await f.post(received({ message_handle: '' }))).status).toBe(400);
  expect((await f.post(received({ content: { text: 'hi' } }))).status).toBe(
    400,
  );
  expect(
    (
      await fetch(`http://127.0.0.1:${f.port}/api/state`, {
        headers: { 'sb-signing-secret': SECRET },
      })
    ).status,
  ).toBe(404);
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.api.sent).toHaveLength(0);
});

it('ignores echoes, receipts, groups, other lines, unknown senders and empty texts', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await f.platform.start();
  for (const event of [
    received({ is_outbound: true, status: 'SENT' }),
    received({ status: 'DELIVERED' }),
    received({ group_id: 'group-1' }),
    received({ to_number: '+15550109999' }),
    received({ from_number: '+15550109999' }),
    received({ content: '   ' }),
    received({ content: null }),
  ])
    expect((await f.post(event)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.api.sent).toHaveLength(0);
  expect(JSON.stringify(log.mock.calls)).not.toContain('+15550109999');
});

it('answers a redelivered message handle once', async () => {
  const f = await fixture();
  await f.platform.start();
  const event = received();
  expect((await f.post(event)).status).toBe(200);
  expect((await f.post(event)).status).toBe(200);
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.turn).toHaveBeenCalledOnce();
  expect(f.api.sent).toHaveLength(1);
});

it('refuses work past the queue bound without consuming the retry, and batches bursts', async () => {
  const f = await fixture();
  await f.platform.start();
  const gate = deferred();
  f.turn.mockImplementationOnce(async (_thread, prompt) => {
    await gate.promise;
    return `First: ${prompt}`;
  });
  await f.post(received({ content: 'first' }));
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledOnce());
  for (let index = 0; index < 32; index += 1)
    expect(
      (await f.post(received({ content: `queued ${index}` }))).status,
    ).toBe(200);
  const overflow = received({ content: 'overflow' });
  expect((await f.post(overflow)).status).toBe(503);
  gate.resolve();
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(2));
  // The queued burst from one sender became one turn, in arrival order.
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.turn.mock.calls[1][1]).toBe(
    Array.from({ length: 32 }, (_, index) => `queued ${index}`).join('\n\n'),
  );
  expect((await f.post(overflow)).status).toBe(200);
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(3));
  const original = f.turn.mock.calls[2][0];
  expect(f.turn).toHaveBeenLastCalledWith(
    original,
    'overflow',
    expect.any(AbortSignal),
    { opendotsSource: 'sendblue' },
  );

  // `/new` in a burst is never merged into the texts around it.
  const next = deferred();
  f.turn.mockImplementationOnce(async () => {
    await next.promise;
    return 'Done';
  });
  await f.post(received({ content: 'before' }));
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(4));
  for (const content of ['/new', 'Plan my trip', 'and book it'])
    await f.post(received({ content }));
  next.resolve();
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(6));
  expect(f.api.sent.slice(3).map((sent) => sent.body.content)).toEqual([
    'Done',
    'Started a new conversation.',
    'Noted: Plan my trip\n\nand book it',
  ]);
  expect(f.turn.mock.calls[4][0]).not.toBe(original);
  expect(f.turn.mock.calls[4][1]).toBe('Plan my trip\n\nand book it');
});

it('replies with a paused notice and does not run the Dot while paused', async () => {
  const f = await fixture();
  await f.platform.start();
  f.store.updateSettings({ paused: true });
  await f.post(received());
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(1));
  expect(f.api.sent[0].body.content).toBe(
    'OpenDots is paused. Resume it in the app before asking me to continue.',
  );
  expect(f.turn).not.toHaveBeenCalled();
});

it('sends a generic reply and logs only a safe failure name when a turn fails', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await f.platform.start();
  f.turn.mockRejectedValueOnce(
    new Error('provider said: Bearer sk-live-leaked-token'),
  );
  await f.post(received());
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(1));
  expect(f.api.sent[0].body.content).toBe(
    'I couldn’t complete that request. Please check OpenDots and text me again when you’re ready.',
  );
  expect(log).toHaveBeenCalledWith(
    'Sendblue turn failed; error reply sent: Error',
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('sk-live');
});

it('never resends a reply that Sendblue rejected or did not confirm', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await f.platform.start();
  const failures: [() => Response, string][] = [
    [
      () =>
        new Response('{"message":"sb-api-secret-key invalid"}', {
          status: 500,
        }),
      'Error (HTTP 500)',
    ],
    [
      () =>
        Response.json({
          status: 'ERROR',
          message_handle: 'handle',
          error_code: 10001,
        }),
      'Error',
    ],
    [() => Response.json({ status: 'QUEUED', error_code: 0 }), 'Error'],
    [
      () =>
        Response.json({
          status: 'QUEUED',
          message_handle: 'handle',
          error_code: 4000,
        }),
      'Error',
    ],
    [() => Response.error(), 'TypeError'],
  ];
  const unconfirmed = () =>
    log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('Sendblue did not confirm'));
  for (const [index, [respond, failure]] of failures.entries()) {
    f.api.respond(respond);
    await f.post(received());
    await vi.waitFor(() => expect(unconfirmed()).toHaveLength(index + 1));
    expect(unconfirmed().at(-1)).toBe(
      `Sendblue did not confirm reply part 1 of 1; it was not resent and later parts were not sent: ${failure}`,
    );
    expect(f.api.sent).toHaveLength(index + 1);
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain('sb-api-secret-key');

  // A long reply stops at the first unconfirmed part.
  let calls = 0;
  f.api.respond(() =>
    ++calls === 2
      ? new Response(null, { status: 502 })
      : Response.json({ status: 'SENT', message_handle: randomUUID() }),
  );
  f.turn.mockResolvedValueOnce(
    Array.from({ length: 3 }, (_, part) => `${part}`.repeat(1400)).join('\n\n'),
  );
  await f.post(received());
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith(
      'Sendblue did not confirm reply part 2 of 3; it was not resent and later parts were not sent: Error (HTTP 502)',
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.api.sent).toHaveLength(failures.length + 2);
});

it('describes attachments as text without fetching them', async () => {
  const f = await fixture();
  await f.platform.start();
  await f.post(
    received({
      content: 'What is this?',
      media_url: `${f.api.origin}/media/photo.jpg`,
    }),
  );
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(1));
  expect(f.turn.mock.calls[0][1]).toBe(
    'What is this?\n\n[The sender attached media. OpenDots reads text messages only.]',
  );
  await f.post(
    received({ content: '', media_url: `${f.api.origin}/media/a.jpg` }),
  );
  await vi.waitFor(() => expect(f.api.sent).toHaveLength(2));
  expect(f.api.media).toEqual([]);
});

it('stays offline until conversations, the Dot and the port are usable, and stops cleanly', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const unconfigured = await fixture({ config: { intelligenceKey: '' } });
  await unconfigured.platform.start();
  expect(unconfigured.platform.setup().sendblue).toBe('setup_required');
  await expect(unconfigured.post(received())).rejects.toThrow();
  expect(log).toHaveBeenCalledWith(
    'Sendblue setup required: conversation setup',
  );

  const missingDot = await fixture({ sendblue: { dotId: 'missing' } });
  await missingDot.platform.start();
  expect(missingDot.platform.setup().sendblue).toBe('setup_required');
  expect(log).toHaveBeenCalledWith(
    'Sendblue setup required: SENDBLUE_DOT_ID (an existing Dot)',
  );

  const running = await fixture();
  await running.platform.start();
  const conflict = await fixture({
    sendblue: { webhookPort: running.port },
  });
  await conflict.platform.start();
  expect(conflict.platform.setup().sendblue).toBe('activation_failed');
  expect(log).toHaveBeenCalledWith(
    'Sendblue webhook listener failed: EADDRINUSE',
  );

  // Stopping aborts an in-flight turn and sends nothing afterwards, whether
  // the turn rejects on abort or still returns a late answer.
  for (const settle of ['reject', 'resolve'] as const) {
    const f = settle === 'reject' ? running : await fixture();
    if (f !== running) await f.platform.start();
    let aborted = false;
    f.turn.mockImplementationOnce(
      (_thread, _prompt, signal) =>
        new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            if (settle === 'reject') reject(signal.reason);
            else resolve('Late answer');
          }),
        ),
    );
    log.mockClear();
    await f.post(received());
    await vi.waitFor(() => expect(f.turn).toHaveBeenCalledOnce());
    await f.stop();
    expect(aborted).toBe(true);
    expect(f.api.sent).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    await expect(f.post(received())).rejects.toThrow();
  }
});

it('turns Markdown into readable text and splits long replies on boundaries', () => {
  expect(
    plainText(
      '## Plan\n\n**Book** the [venue](https://v.example) and see https://x.example\n- one\n  * `two`\n\n\n\n```ts\ncode()\n```',
    ),
  ).toBe(
    'Plan\n\nBook the venue (https://v.example) and see https://x.example\n• one\n  • two\n\ncode()',
  );
  expect(plainText('[https://a.example](https://a.example)')).toBe(
    'https://a.example',
  );
  const paragraphs = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(10)];
  expect(splitReply(paragraphs.join('\n\n'))).toEqual([
    paragraphs[0],
    `${paragraphs[1]}\n\n${paragraphs[2]}`,
  ]);
  // The hard cut at 1,500 lands inside an emoji and moves back one unit.
  const unbroken = `x${'😀'.repeat(1000)}`;
  const parts = splitReply(unbroken);
  expect(parts.join('')).toBe(unbroken);
  expect(parts.every((part) => part.length <= 1500)).toBe(true);
  expect(parts.every((part) => !/^[\uDC00-\uDFFF]/.test(part))).toBe(true);
  expect(splitReply('short')).toEqual(['short']);
});
