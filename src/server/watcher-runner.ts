import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

const MAX_BODY = 1_000_000;
const MAX_REDIRECTS = 3;

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  const value = address.toLowerCase();
  return (
    value === '::1' ||
    value === '::' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:')
  );
}

async function validatePublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Watcher URLs must be public HTTP(S) URLs without credentials.');

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    throw new Error('Watcher URL resolves to a local hostname.');

  if (isIP(hostname) && privateAddress(hostname))
    throw new Error('Watcher URL resolves to a private address.');

  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address)))
    throw new Error('Watcher URL resolves to a private or local address.');

  return url;
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY)
        throw new Error('Watcher response exceeded the 1 MB limit.');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(data);
}

async function fetchPublicBody(start: string): Promise<string> {
  let current = await validatePublicUrl(start);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': 'OpenDots/0.1 watcher' },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Watcher redirect did not provide a location.');
      if (redirect === MAX_REDIRECTS)
        throw new Error('Watcher followed too many redirects.');
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Watcher HTTP ${response.status}.`);
    return readBody(response);
  }

  throw new Error('Watcher request failed.');
}

export class WatcherRunner {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private store: Store,
    private workspace: WorkspaceStore,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    const settings = this.store.settings();
    if (
      this.running ||
      settings.paused ||
      !settings.researchAllowed ||
      !this.store.dueWatchers().length
    )
      return;

    this.running = true;
    try {
      for (const watcher of this.store.dueWatchers()) {
        const checkedAt = Date.now();
        const nextCheckAt =
          checkedAt + watcher.intervalSeconds * 1000;

        try {
          this.workspace.requireThread(watcher.threadId);
          const body = await fetchPublicBody(watcher.url);
          const hash = createHash('sha256').update(body).digest('hex');

          if (watcher.lastHash && watcher.lastHash !== hash) {
            const task = this.store.createTask(
              `A watched page changed: ${watcher.url}\\n\\n${watcher.prompt}`,
            );
            this.workspace.bindTask(task.id, watcher.threadId);
            this.store.createInboxItem(
              'watch_triggered',
              'A watcher detected a change',
              `${watcher.url}\\n\\nA new task was queued in the selected conversation.`,
              task.id,
            );
          }

          this.store.updateWatcherCheck(watcher.id, {
            lastCheckedAt: checkedAt,
            lastHash: hash,
            nextCheckAt,
            error: null,
          });
        } catch (error) {
          this.store.updateWatcherCheck(watcher.id, {
            lastCheckedAt: checkedAt,
            nextCheckAt,
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : 'Watcher check failed.',
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
