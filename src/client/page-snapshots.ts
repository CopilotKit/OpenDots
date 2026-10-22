import type { Page } from '../server/pages';
/** Pages currently have no delete operation. A missing row in an older poll
 * must not unmount a newly created document. Deletion would require explicit
 * tombstones or mutation ordering, rather than interpreting absence here. */
export function mergePageSnapshot(known: Page[], incoming: Page[]): Page[] {
  const pages = new Map(known.map((page) => [page.id, page]));
  for (const page of incoming) {
    const previous = pages.get(page.id);
    if (!previous || page.revision > previous.revision)
      pages.set(page.id, page);
  }
  return [...pages.values()];
}
