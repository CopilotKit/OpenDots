import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { execFile } from 'node:child_process';
import {
  IMessageBridge,
  attributedBodyText,
  macMessages,
  normalizeHandle,
  plainText,
  type IncomingText,
  type MessagesSource,
} from '../src/server/imessage.js';
import { WorkspaceStore } from '../src/server/workspace.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));
const APPLE_EPOCH_MS = 978_307_200_000;
const archived = (text: string) => {
  const bytes = Buffer.from(text);
  const length =
    bytes.length < 0x80
      ? Buffer.from([bytes.length])
      : Buffer.from([0x81, bytes.length & 0xff, bytes.length >> 8]);
  return Buffer.concat([
    Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84'),
    Buffer.from('NSString'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    length,
    bytes,
    Buffer.from([0x86, 0x84]),
  ]);
};
it('decodes archived message bodies, short and long', () => {
  expect(attributedBodyText(archived('Hi Dot 👋'))).toBe('Hi Dot 👋');
  const long = 'x'.repeat(300);
  expect(attributedBodyText(archived(long))).toBe(long);
  expect(attributedBodyText(null)).toBe('');
  expect(attributedBodyText(Buffer.from('garbage'))).toBe('');
});
it('normalizes phone and email handles', () => {
  expect(normalizeHandle('+1 (555) 010-2000')).toBe('+15550102000');
  expect(normalizeHandle('15550102000')).toBe('+15550102000');
  expect(normalizeHandle(' Me@iCloud.com ')).toBe('me@icloud.com');
});
it('turns Markdown replies into readable plain text', () => {
  expect(
    plainText(
      '## Plan\n\n**Book** the [venue](https://v.example)\n- one\n- `two`\n\n\n\nDone',
    ),
  ).toBe('Plan\n\nBook the venue (https://v.example)\n• one\n• two\n\nDone');
});
function chatDb() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-imessage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle(ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat(ROWID INTEGER PRIMARY KEY, style INTEGER, chat_identifier TEXT);
    CREATE TABLE message(ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER);
    CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550102000'), (2, 'friend@example.com');
    INSERT INTO chat VALUES (1, 45, '+15550102000'), (2, 43, 'chat-group');`);
  const add = (
    id: number,
    handle: number,
    chat: number,
    text: string | null,
    body: Buffer | null = null,
    fromMe = 0,
  ) => {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      text,
      body,
      handle,
      fromMe,
      (Date.UTC(2026, 9, 3) - APPLE_EPOCH_MS) * 1_000_000,
    );
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chat, id);
  };
  add(1, 1, 1, 'old message');
  add(2, 1, 1, null, archived('What is on today?'));
  add(3, 2, 2, 'group chatter');
  add(4, 1, 1, 'my own reply', null, 1);
  db.close();
  return path;
}
it('reads only incoming one-to-one messages from the Messages database', () => {
  const source = macMessages(chatDb());
  expect(source.latestId()).toBe(4);
  expect(source.since(1)).toEqual([
    {
      id: 2,
      handle: '+15550102000',
      text: 'What is on today?',
      sentAt: Date.UTC(2026, 9, 3),
    },
  ]);
});
it('sends through Messages with the reply passed as an argument, not script', async () => {
  const run = vi.fn((_file, _args, _options, done) => done(null)) as never;
  const source = macMessages(chatDb(), run as typeof execFile);
  await source.send('+15550102000', '"); do shell script "rm -rf ~');
  const [file, args] = (run as unknown as ReturnType<typeof vi.fn>).mock
    .calls[0];
  expect(file).toBe('osascript');
  expect(args.slice(2)).toEqual([
    '+15550102000',
    '"); do shell script "rm -rf ~',
  ]);
  expect(args[1]).not.toContain('rm -rf');
});
function bridge(
  options: { paused?: boolean; turn?: () => Promise<string> } = {},
) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const inbox: IncomingText[] = [];
  const outbox: [string, string][] = [];
  let next = 10;
  const now = Date.UTC(2026, 9, 3, 12);
  const source: MessagesSource = {
    latestId: () => 9,
    since: (id) => inbox.filter((message) => message.id > id),
    send: async (handle, text) => {
      outbox.push([handle, text]);
    },
  };
  const threads: string[] = [];
  const turn = vi.fn<
    (threadId: string, prompt: string, signal: AbortSignal) => Promise<string>
  >(options.turn ?? (async () => '**Sure.** On it.'));
  const reports: string[] = [];
  const instance = new IMessageBridge({
    source: () => source,
    state: workspace.imessage,
    handles: ['+1 555 010 2000'],
    dotId: () => workspace.dots()[0].id,
    createThread: async () => {
      threads.push(`thread-${threads.length + 1}`);
      return threads.at(-1)!;
    },
    turn,
    paused: () => options.paused ?? false,
    now: () => now,
    report: (message) => reports.push(message),
  });
  const receive = (handle: string, text: string, age = 0) =>
    inbox.push({ id: next++, handle, text, sentAt: now - age });
  return { instance, workspace, receive, outbox, turn, threads, reports };
}
it('answers allowlisted senders in a persistent conversation, ignoring history and strangers', async () => {
  const f = bridge();
  f.instance.start();
  expect(f.instance.status).toBe('running');
  expect(f.workspace.imessage.cursor()).toBe(9);
  f.receive('+15550102000', 'Plan my day');
  f.receive('+15550102000', 'Include the gym');
  f.receive('+19990000000', 'Hi, I am a stranger');
  await f.instance.poll();
  expect(f.turn).toHaveBeenCalledOnce();
  expect(f.turn.mock.calls[0].slice(0, 2)).toEqual([
    'thread-1',
    'Plan my day\n\nInclude the gym',
  ]);
  expect(f.outbox).toEqual([['+15550102000', 'Sure. On it.']]);
  f.receive('+15550102000', 'Thanks');
  await f.instance.poll();
  expect(f.turn.mock.calls[1][0]).toBe('thread-1');
  expect(f.threads).toEqual(['thread-1']);
  expect(f.workspace.imessage.cursor()).toBe(13);
  f.instance.stop();
});
it('skips stale messages and its own echoed replies', async () => {
  const f = bridge();
  f.instance.start();
  f.receive('+15550102000', 'From two hours ago', 2 * 60 * 60_000);
  f.receive('+15550102000', 'Hello');
  await f.instance.poll();
  expect(f.turn).toHaveBeenCalledOnce();
  // Messaging your own Apple ID: the reply arrives back as incoming.
  f.receive('+15550102000', 'Sure. On it.');
  await f.instance.poll();
  expect(f.turn).toHaveBeenCalledOnce();
  f.instance.stop();
});
it('starts fresh on /new, explains a pause, and recovers from failed turns once', async () => {
  const paused = bridge({ paused: true });
  paused.instance.start();
  paused.receive('+15550102000', 'Hello?');
  await paused.instance.poll();
  expect(paused.turn).not.toHaveBeenCalled();
  expect(paused.outbox[0][1]).toContain('paused');
  paused.instance.stop();
  const failing = bridge({
    turn: async () => {
      throw new Error('model down');
    },
  });
  failing.instance.start();
  failing.receive('+15550102000', 'Hello?');
  failing.receive('+15550102000', '/new');
  await failing.instance.poll();
  expect(failing.outbox).toEqual([
    [
      '+15550102000',
      'I could not finish that. Check OpenDots, then try again.',
    ],
  ]);
  expect(failing.reports.join()).not.toContain('model down');
  await failing.instance.poll();
  expect(failing.turn).toHaveBeenCalledOnce();
  failing.receive('+15550102000', '/NEW');
  await failing.instance.poll();
  expect(failing.outbox.at(-1)).toEqual([
    '+15550102000',
    'Started a new conversation.',
  ]);
  expect(failing.workspace.imessage.thread('+15550102000')).toBe('thread-2');
  failing.instance.stop();
});
it('reports missing Full Disk Access instead of crashing', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const reports: string[] = [];
  const instance = new IMessageBridge({
    source: () => {
      throw new Error('unable to open database file');
    },
    state: workspace.imessage,
    handles: ['+15550102000'],
    dotId: () => 'dot',
    createThread: async () => 'thread',
    turn: async () => '',
    paused: () => false,
    report: (message) => reports.push(message),
  });
  instance.start();
  expect(instance.status).toBe('no_access');
  expect(reports[0]).toContain('Full Disk Access');
});
