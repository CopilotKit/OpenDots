import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('failed recurring tasks', () => {
  afterEach(() => vi.restoreAllMocks());
  it('retains failure history and retries only when the interval is due', () => {
    const { store, path } = fixture();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const task = store.createTask('Recurring', 60);
    store.fail(store.claim(now)!, 'Provider unavailable');
    expect(store.task(task.id)).toMatchObject({
      status: 'failed',
      error: 'Provider unavailable',
      nextRunAt: now + 60000,
    });
    expect(store.claim(now + 59999)).toBeNull();
    const second = new Store(path);
    try {
      const retry = second.claim(now + 60000)!;
      expect(retry.id).toBe(task.id);
      expect(store.claim(now + 60000)).toBeNull();
      expect(store.task(task.id)).toMatchObject({
        status: 'running',
        error: null,
        nextRunAt: null,
      });
      expect(store.detail(task.id)?.runs).toHaveLength(2);
      expect(
        store.detail(task.id)?.runs.some((run) => run.status === 'failed'),
      ).toBe(true);
    } finally {
      second.close();
    }
  });
  it('leaves failed one-shot tasks unscheduled', () => {
    const { store } = fixture();
    const task = store.createTask('Once');
    store.fail(store.claim()!, 'Failure');
    expect(store.task(task.id)?.nextRunAt).toBeNull();
    expect(store.claim(Date.now() + 600000)).toBeNull();
  });
  it.each(['pause', 'cancel'] as const)(
    'does not restart after %s or late failure',
    (action) => {
      const { store } = fixture();
      const task = store.createTask('Recurring', 60);
      const old = store.claim()!;
      store.fail(old, 'Failure');
      store.action(task.id, action);
      store.fail(old, 'Late failure');
      expect(store.claim(Date.now() + 600000)).toBeNull();
      expect(store.task(task.id)?.nextRunAt).toBeNull();
    },
  );
  it('removing a failed task schedule prevents a retry', () => {
    const { store } = fixture();
    const task = store.createTask('Recurring', 60);
    store.fail(store.claim()!, 'Failure');
    store.schedule(task.id, null);
    expect(store.claim(Date.now() + 600000)).toBeNull();
  });
});

it('reschedules a failed recurring task when its interval is edited', () => {
  const { store } = fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const task = store.createTask('Recurring', 60);
    store.fail(store.claim(now)!, 'Failure');
    store.schedule(task.id, 120);
    expect(store.task(task.id)?.nextRunAt).toBe(now + 120000);
    expect(store.claim(now + 60000)).toBeNull();
    expect(store.claim(now + 120000)?.id).toBe(task.id);
  } finally {
    vi.restoreAllMocks();
  }
});
