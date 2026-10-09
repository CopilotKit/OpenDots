import type { Page } from '../server/pages';
/** A missing row in an older poll must not unmount a newly created document,
 * so absence never removes a page. Deletions are explicit: ids in `removed`
 * (tombstones kept by the caller) are ignored when a stale poll still lists them. */
export function mergePageSnapshot(
  known: Page[],
  incoming: Page[],
  removed: ReadonlySet<string> = new Set(),
): Page[] {
  const pages = new Map(known.map((page) => [page.id, page]));
  for (const page of incoming) {
    if (removed.has(page.id)) continue;
    const previous = pages.get(page.id);
    if (!previous || page.revision > previous.revision)
      pages.set(page.id, page);
  }
  return [...pages.values()];
}
