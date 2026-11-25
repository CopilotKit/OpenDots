import type { Page } from '../server/pages';
/** Reconcile a complete list, retaining only explicitly protected missing rows.
 * The caller protects an open document or local changes newer than this poll.
 * Local deletion tombstones always win, including over protected rows. */
export function mergePageSnapshot(
  known: Page[],
  incoming: Page[],
  removed: ReadonlySet<string> = new Set(),
  retained: ReadonlySet<string> = new Set(),
): Page[] {
  const listed = new Set(incoming.map((page) => page.id));
  const pages = new Map(
    known
      .filter(
        (page) =>
          !removed.has(page.id) &&
          (listed.has(page.id) || retained.has(page.id)),
      )
      .map((page) => [page.id, page]),
  );
  for (const page of incoming) {
    if (removed.has(page.id)) continue;
    const previous = pages.get(page.id);
    if (!previous || page.revision > previous.revision)
      pages.set(page.id, page);
  }
  return [...pages.values()];
}
