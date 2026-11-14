import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { safeFailure } from './slack-channel.js';
export interface IncomingText {
  id: number;
  handle: string;
  text: string;
  sentAt: number;
}
export interface MessagesSource {
  latestId(): number;
  since(id: number): IncomingText[];
  send(handle: string, text: string): Promise<void>;
}
// Apple stores message dates since 2001-01-01: nanoseconds on current macOS,
// seconds on old versions. Nanoseconds overflow JS numbers, so SQL converts.
const APPLE_EPOCH_MS = 978_307_200_000;
// Newer macOS versions leave message.text empty and keep the body in an
// archived NSAttributedString. Its first NSString payload is the plain text.
export function attributedBodyText(body: Uint8Array | null): string {
  if (!body) return '';
  const buffer = Buffer.from(body);
  const marker = buffer.indexOf('NSString');
  if (marker < 0) return '';
  let at = marker + 'NSString'.length + 5;
  let length = buffer[at];
  at += 1;
  if (length === 0x81) {
    length = buffer.readUInt16LE(at);
    at += 2;
  } else if (length === 0x82) {
    length = buffer.readUInt32LE(at);
    at += 4;
  }
  if (length === undefined || at + length > buffer.length) return '';
  return buffer.subarray(at, at + length).toString('utf8');
}
export function normalizeHandle(value: string) {
  const handle = value.trim().toLowerCase();
  if (handle.includes('@')) return handle;
  const digits = handle.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}
// Dots answer in Markdown; Messages shows plain text.
export function plainText(markdown: string) {
  return markdown
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
      text === url ? url : `${text} (${url})`,
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const sendScript = `on run argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    send (item 2 of argv) to participant (item 1 of argv) of targetService
  end tell
end run`;
export function macMessages(
  path = join(homedir(), 'Library', 'Messages', 'chat.db'),
  run: typeof execFile = execFile,
): MessagesSource {
  // Read-only: OpenDots never writes to the Messages database.
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    latestId() {
      const row = db.prepare('SELECT MAX(ROWID) AS id FROM message').get();
      return Number(row?.id ?? 0);
    },
    since(id) {
      // One-to-one chats only (chat.style 45); group chats are ignored.
      return db
        .prepare(
          `SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body, h.id AS handle,
             CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS dateMs
           FROM message m
           JOIN handle h ON h.ROWID = m.handle_id
           JOIN chat_message_join j ON j.message_id = m.ROWID
           JOIN chat c ON c.ROWID = j.chat_id
           WHERE m.ROWID > ? AND m.is_from_me = 0 AND c.style = 45
           ORDER BY m.ROWID LIMIT 100`,
        )
        .all(id)
        .map((row) => ({
          id: Number(row.id),
          handle: String(row.handle),
          text:
            typeof row.text === 'string' && row.text.trim()
              ? row.text
              : attributedBodyText(row.body as Uint8Array | null),
          sentAt: Number(row.dateMs ?? 0) + APPLE_EPOCH_MS,
        }));
    },
    send(handle, text) {
      return new Promise((resolve, reject) =>
        run(
          'osascript',
          ['-e', sendScript, handle, text],
          { timeout: 30_000 },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
  };
}
export interface BridgeState {
  cursor(): number | undefined;
  setCursor(id: number): void;
  thread(handle: string): string | undefined;
  setThread(handle: string, threadId: string): void;
}
export type BridgeStatus =
  'not_configured' | 'unsupported' | 'running' | 'no_access';
export class IMessageBridge {
  status: BridgeStatus = 'not_configured';
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private controller = new AbortController();
  private allowed: Set<string>;
  private sent = new Map<string, number>();
  constructor(
    private options: {
      source: () => MessagesSource;
      state: BridgeState;
      handles: string[];
      dotId: () => string;
      createThread: (dotId: string, title: string) => Promise<string>;
      turn: (
        threadId: string,
        prompt: string,
        signal: AbortSignal,
      ) => Promise<string>;
      paused: () => boolean;
      intervalMs?: number;
      maxAgeMs?: number;
      now?: () => number;
      report?: (message: string) => void;
    },
  ) {
    this.allowed = new Set(options.handles.map(normalizeHandle));
  }
  private source?: MessagesSource;
  start() {
    try {
      this.source = this.options.source();
      // First run starts at the newest message: history is never answered.
      if (this.options.state.cursor() === undefined)
        this.options.state.setCursor(this.source.latestId());
    } catch (error) {
      this.status = 'no_access';
      this.report(
        `iMessage bridge could not open the Messages database (${safeFailure(error)}). Grant Full Disk Access to the app that runs OpenDots.`,
      );
      return;
    }
    this.status = 'running';
    this.timer = setInterval(
      () => void this.poll(),
      this.options.intervalMs ?? 3000,
    );
  }
  stop() {
    clearInterval(this.timer);
    this.controller.abort();
  }
  private report(message: string) {
    (this.options.report ?? console.error)(message);
  }
  private fingerprint(handle: string, text: string) {
    return createHash('sha256')
      .update(`${normalizeHandle(handle)}\n${text.trim()}`)
      .digest('hex');
  }
  // Messaging your own Apple ID echoes each reply back as incoming.
  private isEcho(handle: string, text: string) {
    const now = this.now();
    for (const [key, at] of this.sent)
      if (now - at > 120_000) this.sent.delete(key);
    return this.sent.has(this.fingerprint(handle, text));
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async reply(handle: string, text: string) {
    const body = plainText(text) || '…';
    this.sent.set(this.fingerprint(handle, body), this.now());
    await this.source!.send(handle, body);
  }
  async poll() {
    if (this.busy || !this.source) return;
    this.busy = true;
    try {
      const cursor = this.options.state.cursor() ?? 0;
      const messages = this.source.since(cursor);
      if (!messages.length) return;
      // Advance first: a failing message must never be answered twice.
      this.options.state.setCursor(messages.at(-1)!.id);
      const maxAge = this.options.maxAgeMs ?? 60 * 60_000;
      const batches = new Map<string, string[]>();
      for (const message of messages) {
        const handle = normalizeHandle(message.handle);
        const text = message.text.trim();
        if (
          !text ||
          !this.allowed.has(handle) ||
          this.now() - message.sentAt > maxAge ||
          this.isEcho(message.handle, text)
        )
          continue;
        batches.set(message.handle, [
          ...(batches.get(message.handle) ?? []),
          text,
        ]);
      }
      for (const [handle, texts] of batches)
        await this.answer(handle, texts.join('\n\n'));
    } catch (error) {
      this.report(`iMessage poll failed: ${safeFailure(error)}`);
    } finally {
      this.busy = false;
    }
  }
  private async answer(handle: string, text: string) {
    const key = normalizeHandle(handle);
    try {
      if (this.options.paused()) {
        await this.reply(
          handle,
          'OpenDots is paused. Resume it in the app, then message me again.',
        );
        return;
      }
      if (text.toLowerCase() === '/new') {
        const threadId = await this.options.createThread(
          this.options.dotId(),
          `iMessage · ${key}`,
        );
        this.options.state.setThread(key, threadId);
        await this.reply(handle, 'Started a new conversation.');
        return;
      }
      let threadId = this.options.state.thread(key);
      if (!threadId) {
        threadId = await this.options.createThread(
          this.options.dotId(),
          `iMessage · ${key}`,
        );
        this.options.state.setThread(key, threadId);
      }
      const signal = AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(120_000),
      ]);
      await this.reply(handle, await this.options.turn(threadId, text, signal));
    } catch (error) {
      this.report(`iMessage turn failed: ${safeFailure(error)}`);
      await this.reply(
        handle,
        'I could not finish that. Check OpenDots, then try again.',
      ).catch(() => {});
    }
  }
}
