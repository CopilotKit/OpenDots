import { timingSafeEqual } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import type { Platform } from './platform.js';

const PHONE = /^\+[1-9]\d{7,14}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUED = 32;
export const SENDBLUE_REPLY_DEADLINE_MS = 120_000;
const SEND_LIMIT_MS = 30_000;
// Stays under the 1,600-character limit for long messages sent as SMS.
const PART_LENGTH = 1500;
const ACCEPTED = new Set(['QUEUED', 'SENT', 'DELIVERED', 'READ']);
export const SENDBLUE_WEBHOOK_PATH = '/sendblue/webhook';
const PAUSED =
  'OpenDots is paused. Resume it in the app before asking me to continue.';
const FAILED =
  'I couldn’t complete that request. Please check OpenDots and text me again when you’re ready.';
const ATTACHMENT =
  '[The sender attached media. OpenDots reads text messages only.]';

export interface SendblueConfig {
  apiKey: string;
  apiSecret: string;
  fromNumber: string;
  webhookSecret: string;
  allowedNumbers: string[];
  dotId?: string;
  webhookHost: string;
  webhookPort: number;
  apiUrl: string;
}
export type SendblueStatus =
  | 'not_configured'
  | 'setup_required'
  | 'starting'
  | 'listening'
  | 'activation_failed'
  | 'stopped';
const SENDBLUE_ENV = [
  'SENDBLUE_API_KEY',
  'SENDBLUE_API_SECRET',
  'SENDBLUE_FROM_NUMBER',
  'SENDBLUE_WEBHOOK_SECRET',
  'SENDBLUE_ALLOWED_NUMBERS',
];
export function sendblueConfigFromEnv(
  env: Record<string, string | undefined>,
): SendblueConfig | undefined {
  const value = (name: string) => env[name]?.trim() ?? '';
  if (!SENDBLUE_ENV.some((name) => value(name))) return undefined;
  return {
    apiKey: value('SENDBLUE_API_KEY'),
    apiSecret: value('SENDBLUE_API_SECRET'),
    fromNumber: value('SENDBLUE_FROM_NUMBER'),
    webhookSecret: value('SENDBLUE_WEBHOOK_SECRET'),
    allowedNumbers: value('SENDBLUE_ALLOWED_NUMBERS')
      .split(',')
      .map((number) => number.trim())
      .filter(Boolean),
    dotId: value('SENDBLUE_DOT_ID') || undefined,
    webhookHost: value('HOST') || '127.0.0.1',
    webhookPort: Number(value('SENDBLUE_WEBHOOK_PORT') || 4313),
    apiUrl: 'https://api.sendblue.com/api/send-message',
  };
}
export function sendblueProblems(config: SendblueConfig): string[] {
  return [
    !config.apiKey && 'SENDBLUE_API_KEY',
    !config.apiSecret && 'SENDBLUE_API_SECRET',
    !PHONE.test(config.fromNumber) &&
      'SENDBLUE_FROM_NUMBER (the assigned line in E.164 format)',
    config.webhookSecret.length < 24 &&
      'SENDBLUE_WEBHOOK_SECRET (24 or more characters)',
    (!config.allowedNumbers.length ||
      config.allowedNumbers.some(
        (number) => !PHONE.test(number) || number === config.fromNumber,
      )) &&
      'SENDBLUE_ALLOWED_NUMBERS (E.164 numbers other than the assigned line)',
    !(
      Number.isInteger(config.webhookPort) &&
      config.webhookPort > 0 &&
      config.webhookPort < 65536
    ) && 'SENDBLUE_WEBHOOK_PORT',
  ].filter((problem): problem is string => !!problem);
}

// Dots answer in Markdown; texts show it literally.
export function plainText(markdown: string) {
  return markdown
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function splitReply(text: string, length = PART_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > length) {
    let at =
      ['\n\n', '\n', ' ']
        .map((separator) => rest.lastIndexOf(separator, length))
        .find((index) => index > length / 2) ?? length;
    // Never split a surrogate pair at a hard cut.
    if (/[\uD800-\uDBFF]/.test(rest[at - 1])) at -= 1;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  return rest ? [...parts, rest] : parts;
}
function accepted(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return false;
  const { message_handle, status, error_code } = result as Record<
    string,
    unknown
  >;
  return (
    typeof message_handle === 'string' &&
    !!message_handle &&
    ACCEPTED.has(String(status)) &&
    (error_code == null || error_code === 0)
  );
}
async function readText(request: Request, limit: number) {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  hostname: string,
  port: number,
) {
  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => {
      server.off('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}
function listenFailure(error: unknown) {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
    ? code
    : safeFailure(error);
}
// Stops waiting at the deadline even for work that cannot be cancelled, such
// as Intelligence conversation creation, so one stalled request never blocks
// the shared queue.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
const empty = (status: number) => new Response(null, { status });
const isNew = (text: string) => text.trim().toLowerCase() === '/new';

type Host = Pick<
  Platform,
  'store' | 'workspace' | 'createConversation' | 'turn'
> & { setup(): { missing: string[] } };
interface Inbound {
  number: string;
  text: string;
}
export class SendblueBridge {
  status: SendblueStatus = 'starting';
  private server?: ServerType;
  private queue: Inbound[] = [];
  private draining?: Promise<void>;
  private controller = new AbortController();
  private allowed: Set<string>;
  constructor(
    private host: Host,
    private config: SendblueConfig,
  ) {
    this.allowed = new Set(config.allowedNumbers);
  }
  private dotId() {
    return this.config.dotId ?? this.host.workspace.dots()[0].id;
  }
  async start() {
    const problems = sendblueProblems(this.config);
    if (!problems.length && !this.host.workspace.dot(this.dotId()))
      problems.push('SENDBLUE_DOT_ID (an existing Dot)');
    if (!problems.length && this.host.setup().missing.length)
      problems.push('conversation setup');
    if (problems.length) {
      this.status = 'setup_required';
      reportChannelFailure('Sendblue setup required', problems);
      return;
    }
    this.status = 'starting';
    const app = new Hono();
    app.post(SENDBLUE_WEBHOOK_PATH, (c) => this.receive(c.req.raw));
    app.all('*', (c) => c.body(null, 404));
    try {
      const server = await listen(
        app.fetch,
        this.config.webhookHost,
        this.config.webhookPort,
      );
      if (this.controller.signal.aborted) {
        server.close();
        return;
      }
      this.server = server;
      this.status = 'listening';
    } catch (error) {
      this.status = 'activation_failed';
      reportChannelFailure('Sendblue webhook listener failed', [
        listenFailure(error),
      ]);
    }
  }
  async stop() {
    this.controller.abort();
    this.queue = [];
    if (this.status === 'starting' || this.status === 'listening')
      this.status = 'stopped';
    const server = this.server;
    this.server = undefined;
    await Promise.all([
      server &&
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          if ('closeAllConnections' in server) server.closeAllConnections();
        }),
      this.draining,
    ]);
  }
  async receive(request: Request): Promise<Response> {
    if (this.status !== 'listening') return empty(503);
    // Authenticate before reading the body.
    const supplied = Buffer.from(
      request.headers.get('sb-signing-secret') ?? '',
    );
    const expected = Buffer.from(this.config.webhookSecret);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return empty(401);
    try {
      const body = await readText(request, MAX_BODY_BYTES);
      if (body === undefined) return empty(413);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return empty(400);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return empty(400);
      const event = payload as Record<string, unknown>;
      // Only one-to-one messages received on this line start a turn.
      if (
        event.is_outbound !== false ||
        event.status !== 'RECEIVED' ||
        (event.group_id != null && event.group_id !== '') ||
        event.to_number !== this.config.fromNumber
      )
        return empty(200);
      const { from_number, message_handle, content, media_url } = event;
      if (
        typeof from_number !== 'string' ||
        !PHONE.test(from_number) ||
        typeof message_handle !== 'string' ||
        !message_handle ||
        message_handle.length > 256 ||
        (content != null && typeof content !== 'string') ||
        (media_url != null && typeof media_url !== 'string')
      )
        return empty(400);
      if (!this.allowed.has(from_number)) {
        reportChannelFailure('Sendblue message ignored', [
          'sender is not in SENDBLUE_ALLOWED_NUMBERS',
        ]);
        return empty(200);
      }
      // Media URLs are never fetched.
      const text = [content?.trim(), media_url ? ATTACHMENT : '']
        .filter(Boolean)
        .join('\n\n');
      if (!text) return empty(200);
      // Refuse before claiming the handle so Sendblue's retry is accepted.
      if (this.queue.length >= MAX_QUEUED) return empty(503);
      if (!this.host.workspace.sendblue.claim(message_handle))
        return empty(200);
      this.queue.push({ number: from_number, text });
      this.drain();
      return empty(200);
    } catch (error) {
      reportChannelFailure('Sendblue webhook failed', [safeFailure(error)]);
      return empty(503);
    }
  }
  private drain() {
    this.draining ??= (async () => {
      while (this.queue.length && !this.controller.signal.aborted) {
        const { number } = this.queue[0];
        // A burst of texts from one sender becomes one turn; `/new` stays
        // separate so the texts after it start the new conversation.
        const batch: Inbound[] = [];
        for (const item of this.queue) {
          if (item.number !== number) continue;
          if (batch.length && (isNew(item.text) || isNew(batch[0].text))) break;
          batch.push(item);
        }
        this.queue = this.queue.filter((item) => !batch.includes(item));
        await this.answer(number, batch.map((item) => item.text).join('\n\n'));
      }
    })().finally(() => {
      this.draining = undefined;
      if (this.queue.length && !this.controller.signal.aborted) this.drain();
    });
  }
  private async thread(number: string, fresh = false) {
    const dotId = this.dotId();
    const current = this.host.workspace.sendblue.thread(number);
    if (
      !fresh &&
      current &&
      this.host.workspace
        .conversations()
        .some((thread) => thread.id === current && thread.dotId === dotId)
    )
      return current;
    const { id } = await this.host.createConversation(
      dotId,
      `Text message ···${number.slice(-4)}`,
    );
    this.host.workspace.sendblue.setThread(number, id);
    return id;
  }
  private async compose(number: string, text: string, signal: AbortSignal) {
    if (this.host.store.settings().paused) return PAUSED;
    if (isNew(text)) {
      await this.thread(number, true);
      return 'Started a new conversation.';
    }
    const threadId = await this.thread(number);
    // A conversation created after the deadline is kept, but never answered.
    signal.throwIfAborted();
    const reply = plainText(
      await this.host.turn(threadId, text, signal, {
        opendotsSource: 'sendblue',
      }),
    );
    if (!reply) throw new Error('The Dot returned no text reply.');
    return reply;
  }
  private async answer(number: string, text: string) {
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(SENDBLUE_REPLY_DEADLINE_MS),
    ]);
    let reply: string;
    try {
      reply = await untilAborted(this.compose(number, text, signal), signal);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      reportChannelFailure('Sendblue turn failed; error reply sent', [
        safeFailure(error),
      ]);
      reply = FAILED;
    }
    if (this.controller.signal.aborted) return;
    const parts = splitReply(reply);
    for (const [index, part] of parts.entries()) {
      try {
        await this.send(number, part);
      } catch (error) {
        // Sendblue has no idempotency key: a request that timed out may still
        // be delivered, so it is never resent automatically.
        reportChannelFailure(
          `Sendblue did not confirm reply part ${index + 1} of ${parts.length}; it was not resent and later parts were not sent`,
          [safeFailure(error)],
        );
        return;
      }
    }
  }
  private async send(number: string, content: string) {
    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(SEND_LIMIT_MS),
      ]),
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': this.config.apiKey,
        'sb-api-secret-key': this.config.apiSecret,
      },
      body: JSON.stringify({
        number,
        from_number: this.config.fromNumber,
        content,
      }),
    });
    if (!response.ok)
      throw Object.assign(new Error('Sendblue rejected the message.'), {
        status: response.status,
      });
    if (!accepted(await response.json().catch(() => undefined)))
      throw new Error('Sendblue did not accept the message.');
  }
}
