import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

const resources: { store: Store; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-'));
  const path = join(dir, 'test.sqlite');
  const store = new Store(path);
  resources.push({ store, dir });
  return { store, path };
}
afterEach(() =>
  resources.splice(0).forEach(({ store, dir }) => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }),
);
describe('durable task lifecycle', () => {
  it('persists tasks and settings across connections', () => {
    const { store, path } = fixture();
    const task = store.createTask('Compare the sample notebooks', 60);
    store.updateSettings({ name: 'Sam' });
    const reopened = new Store(path);
    expect(reopened.task(task.id)?.prompt).toBe(task.prompt);
    expect(reopened.settings().name).toBe('Sam');
    reopened.close();
  });
  it('claims each due job once even through separate database connections', () => {
    const { store, path } = fixture();
    store.createTask('Research one');
    const second = new Store(path);
    const firstClaim = store.claim(1000);
    expect(firstClaim).toBeTruthy();
    expect(second.claim(1000)).toBeNull();
    second.close();
  });
  it('never overwrites a cancellation with a late result', () => {
    const { store } = fixture();
    const task = store.createTask('Research one');
    const claim = store.claim(Date.now())!;
    store.action(task.id, 'cancel');
    expect(
      store.finish(claim, { text: 'Late result', sources: [], sample: true }),
    ).toBe(false);
    expect(store.task(task.id)?.status).toBe('cancelled');
  });
  it('keeps recurring history and schedules only after completion', () => {
    const { store } = fixture();
    const task = store.createTask('Recurring research', 60);
    const now = Date.now();
    const claim = store.claim(now)!;
    store.finish(
      claim,
      { text: 'First result', sources: [], sample: true },
      now,
    );
    expect(store.claim(now + 59_000)).toBeNull();
    expect(store.claim(now + 60_001)?.id).toBe(task.id);
    expect(store.detail(task.id)?.runs).toHaveLength(2);
  });
  it('global pause invalidates running leases and blocks queued jobs', () => {
    const { store } = fixture();
    const task = store.createTask('Research one');
    const claim = store.claim(Date.now())!;
    store.updateSettings({ paused: true });
    expect(store.claim(Date.now())).toBeNull();
    expect(
      store.finish(claim, { text: 'Late result', sources: [], sample: true }),
    ).toBe(false);
    store.updateSettings({ paused: false });
    expect(store.claim(Date.now())?.id).toBe(task.id);
  });
  it('persists inbox items and watcher state', () => {
    const { store } = fixture();
    const item = store.createInboxItem(
      'task_failed',
      'Needs attention',
      'Something failed.',
      'task-1',
    );
    expect(store.unreadInboxCount()).toBe(1);
    expect(store.inboxAction(item.id, 'read')?.readAt).toBeTruthy();
    expect(store.unreadInboxCount()).toBe(0);
    const watcher = store.createWatcher(
      'https://example.com',
      'Investigate changes',
      'thread-1',
      300,
    );
    expect(store.watchers()[0]?.enabled).toBe(true);
    expect(store.watcherAction(watcher.id, 'pause')?.enabled).toBe(false);
    expect(store.watcherAction(watcher.id, 'resume')?.enabled).toBe(true);
    store.updateWatcherCheck(watcher.id, {
      lastCheckedAt: 1000,
      lastHash: 'abc',
      nextCheckAt: 2000,
      error: null,
    });
    expect(store.watchers()[0]?.lastHash).toBe('abc');
    expect(store.watcherAction(watcher.id, 'delete')).toBeUndefined();
    expect(store.watchers()).toHaveLength(0);
  });

  it('recovers expired work after restart without duplicate completion', () => {
    const { store } = fixture();
    store.createTask('Recover me');
    const now = Date.now();
    const old = store.claim(now)!;
    const recovered = store.claim(now + 180_001)!;
    expect(recovered.id).toBe(old.id);
    expect(recovered.lease).not.toBe(old.lease);
    expect(store.finish(old, { text: 'Old', sources: [], sample: true })).toBe(
      false,
    );
    expect(
      store.finish(recovered, { text: 'New', sources: [], sample: true }),
    ).toBe(true);
  });
});
