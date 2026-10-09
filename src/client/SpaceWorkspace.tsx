import { mergePageSnapshot } from './page-snapshots';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../server/pages';
import type { Space, WorkspaceState } from '../shared/types';
import { api } from './api';
import { SpaceLibrary } from './SpaceLibrary';
import { PageDocument } from './PageDocument';
import { PageOutline } from './PageOutline';
export function SpaceWorkspace({
  space,
  pageId,
  workspace,
  paused,
  onPage,
  onDirty,
  onRefresh,
  onSchedule,
  onThread,
  onSettings,
  onCreateDot,
}: {
  space: Space;
  pageId?: string;
  workspace: WorkspaceState;
  paused: boolean;
  onPage: (id?: string) => void;
  onDirty: (value: boolean) => void;
  onRefresh: () => void;
  onSchedule: (threadId: string) => void;
  onThread: (threadId: string) => void;
  onSettings: () => void;
  onCreateDot: () => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const removed = useRef(new Set<string>());
  const mutations = useRef(0);
  const [missingPageId, setMissingPageId] = useState<string>();
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [outline, setOutline] = useState(false);
  useEffect(() => {
    let active = true;
    let loading = false;
    const controller = new AbortController();
    const load = async () => {
      // Serialize polls so an older snapshot cannot arrive after a newer one.
      if (loading) return;
      loading = true;
      const startedAt = mutations.current;
      try {
        const next = await api<Page[]>(
          `/spaces/${space.id}/pages`,
          'GET',
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        if (active) {
          setPages((previous) => {
            const retained = new Set(pageId ? [pageId] : []);
            // A poll begun before a local mutation is not proof of absence.
            if (mutations.current !== startedAt)
              for (const page of previous) retained.add(page.id);
            return mergePageSnapshot(previous, next, removed.current, retained);
          });
          if (mutations.current === startedAt)
            setMissingPageId(
              pageId && !next.some((page) => page.id === pageId)
                ? pageId
                : undefined,
            );
          setLoaded(true);
          setError('');
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load pages.');
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [space.id, pageId]);
  const page = pages.find((item) => item.id === pageId);
  const saved = useCallback((next: Page) => {
    mutations.current++;
    setPages((previous) =>
      previous.map((item) =>
        item.id === next.id && item.revision < next.revision ? next : item,
      ),
    );
  }, []);
  const deleted = useCallback((id: string) => {
    mutations.current++;
    removed.current.add(id);
    setPages((previous) => {
      const parentId =
        previous.find((item) => item.id === id)?.parentId ?? null;
      return previous
        .filter((item) => item.id !== id)
        .map((item) => (item.parentId === id ? { ...item, parentId } : item));
    });
  }, []);
  const create = async (parentId: string | null) => {
    try {
      const next = await api<Page>(`/spaces/${space.id}/pages`, 'POST', {
        title: 'Untitled page',
        content: '',
        parentId,
      });
      mutations.current++;
      setPages((previous) => [...previous, next]);
      onPage(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create page.');
    }
  };
  return (
    <main
      aria-label="Space documents"
      className={`spaces-surface ${pageId ? 'writing' : 'library'}`}
    >
      {error && (
        <div className="document-load-error" role="alert">
          {error}
        </div>
      )}
      {page && missingPageId === pageId && (
        <div className="document-load-error" role="alert">
          This page was deleted elsewhere. Your draft is still available here;
          download it before leaving.
        </div>
      )}
      {!pageId ? (
        <SpaceLibrary
          space={space}
          pages={pages}
          onPage={onPage}
          onNew={() => void create(null)}
        />
      ) : page ? (
        <div className="space-writing-layout">
          {outline && (
            <PageOutline
              pages={pages}
              selected={page.id}
              onPage={(id) => {
                onPage(id);
                if (window.innerWidth < 760) setOutline(false);
              }}
              onNew={() => void create(null)}
              onClose={() => setOutline(false)}
            />
          )}
          <PageDocument
            key={page.id}
            page={page}
            pages={pages}
            workspace={workspace}
            paused={paused}
            onHome={() => onPage()}
            onOutline={() => setOutline(!outline)}
            onSubpage={() => void create(page.id)}
            onDirty={onDirty}
            onSaved={saved}
            onDeleted={deleted}
            onRefresh={onRefresh}
            onSchedule={onSchedule}
            onThread={onThread}
            onSettings={onSettings}
            onCreateDot={onCreateDot}
          />
        </div>
      ) : (
        <div className="library-empty">
          <h2>{loaded ? 'Page not found' : 'Loading page…'}</h2>
          {loaded && (
            <button className="document-primary" onClick={() => onPage()}>
              Back to all pages
            </button>
          )}
        </div>
      )}
    </main>
  );
}
