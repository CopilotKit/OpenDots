import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageAccess } from '../src/server/page-tools.js';

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
    expect(store.claim(Date.now())).toBeNull();
    expect(store.task(task.id)?.status).toBe('interrupted');
    store.action(task.id, 'run');
    expect(store.claim(Date.now())?.id).toBe(task.id);
  });
  it.each([180_000, 480_000])(
    'holds expired work until the owner retries it with a %i ms lease',
    (leaseDurationMs) => {
      const { store, path } = fixture();
      store.createTask('Recover me');
      const now = Date.now();
      const old = store.claim(now, leaseDurationMs)!;
      const restarted = new Store(path);
      try {
        expect(restarted.claim(now + leaseDurationMs - 1)).toBeNull();
        expect(restarted.task(old.id)?.status).toBe('running');
        expect(restarted.claim(now + leaseDurationMs + 1)).toBeNull();
        expect(restarted.task(old.id)?.status).toBe('interrupted');
        expect(restarted.detail(old.id)?.runs[0].status).toBe('interrupted');
        restarted.action(old.id, 'run');
        const recovered = restarted.claim(now + leaseDurationMs + 1)!;
        expect(recovered.id).toBe(old.id);
        expect(recovered.lease).not.toBe(old.lease);
        expect(
          store.finish(old, { text: 'Old', sources: [], sample: true }),
        ).toBe(false);
        expect(
          restarted.finish(recovered, {
            text: 'New',
            sources: [],
            sample: true,
          }),
        ).toBe(true);
      } finally {
        restarted.close();
      }
    },
  );
  it('claims other queued work while an expired run waits for review', () => {
    const { store } = fixture();
    const interrupted = store.createTask('Create the first page');
    const now = Date.now();
    const old = store.claim(now)!;
    const next = store.createTask('Research another topic');

    expect(store.claim(now + 180_001)?.id).toBe(next.id);
    expect(store.task(interrupted.id)?.status).toBe('interrupted');
    expect(store.detail(interrupted.id)?.runs[0].status).toBe('interrupted');
    expect(store.finish(old, { text: 'Late', sources: [], sample: true })).toBe(
      false,
    );
  });
  it('holds an expired run for review after a local page effect', () => {
    const { store, path } = fixture();
    const workspace = new WorkspaceStore(path, 'synthetic-owner');
    try {
      const dot = workspace.dots()[0];
      const thread = workspace.bindThread(
        'scheduled-thread',
        dot.id,
        'Scheduled work',
      );
      const task = store.createTask('Create the sample page once');
      workspace.bindTask(task.id, thread.id);
      const now = Date.now();
      const old = store.claim(now)!;
      const pages = pageAccess(workspace, dot.spaceId, thread.id, () => {});
      pages.create({ title: 'Sample', content: 'Synthetic fixture body' });

      expect(store.claim(now + 180_001)).toBeNull();
      expect(store.task(task.id)?.status).toBe('interrupted');
      expect(store.detail(task.id)?.runs[0].status).toBe('interrupted');
      expect(workspace.pages.list(dot.spaceId)).toHaveLength(1);
      expect(
        store.finish(old, { text: 'Late', sources: [], sample: true }),
      ).toBe(false);

      store.action(task.id, 'run');
      expect(store.claim(now + 180_002)?.id).toBe(task.id);
    } finally {
      workspace.close();
    }
  });
});
