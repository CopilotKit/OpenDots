import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Store } from './store.js';
import { globToRegExp, parseTrigger } from '../shared/triggers.js';

// Watches folders for file-triggered tasks and queues a run (with the new file
// paths as context) when a matching file appears.
export class FileTriggers {
  private watchers = new Map<string, { key: string; watcher: FSWatcher }>();
  private seen = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: Store) {}
  start() {
    this.sync();
    this.timer = setInterval(() => this.sync(), 5000);
  }
  stop() {
    clearInterval(this.timer);
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
  /** Reconcile watchers with the current set of file-triggered tasks. */
  sync() {
    const wanted = new Map<string, { folder: string; pattern: string }>();
    for (const task of this.store.tasks()) {
      const trigger = parseTrigger(task.trigger);
      if (
        trigger?.type === 'file' &&
        !['paused', 'cancelled'].includes(task.status)
      )
        wanted.set(task.id, trigger);
    }
    for (const [id, entry] of this.watchers) {
      const trigger = wanted.get(id);
      if (!trigger || entry.key !== `${trigger.folder}|${trigger.pattern}`) {
        entry.watcher.close();
        this.watchers.delete(id);
      }
    }
    for (const [id, trigger] of wanted) {
      if (this.watchers.has(id) || !existsSync(trigger.folder)) continue;
      const matcher = globToRegExp(trigger.pattern || '*');
      try {
        const watcher = watch(
          trigger.folder,
          { recursive: true },
          (_event, name) => {
            if (!name) return;
            const path = join(trigger.folder, name.toString());
            if (!matcher.test(basename(path))) return;
            // Let the writer finish, then fire once per file per minute.
            setTimeout(() => this.fire(id, path), 1500);
          },
        );
        watcher.on('error', () => this.watchers.delete(id));
        this.watchers.set(id, {
          key: `${trigger.folder}|${trigger.pattern}`,
          watcher,
        });
      } catch (error) {
        console.warn('File trigger unavailable:', String(error));
      }
    }
  }
  private fire(taskId: string, path: string) {
    try {
      if (!existsSync(path) || !statSync(path).isFile()) return;
    } catch {
      return;
    }
    const key = `${taskId}|${path}`;
    const last = this.seen.get(key) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.seen.set(key, Date.now());
    this.store.fire(taskId, `New file: ${path}`);
  }
}
