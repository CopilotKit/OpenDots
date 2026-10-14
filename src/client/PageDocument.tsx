import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  PanelLeft,
  Check,
  LoaderCircle,
  FileCode2,
} from 'lucide-react';
import type { Page } from '../server/pages';
import type { WorkspaceState } from '../shared/types';
import { api } from './api';
import { usePageAutosave } from './editor/use-page-autosave';
import { inspectMarkdown } from './editor/markdown';
import { DocumentMenu } from './editor/DocumentMenu';
import { PageConversation } from './PageConversation';
import { PageHistory } from './PageHistory';
const RichEditor = lazy(() => import('./editor/RichEditor'));
export function PageDocument({
  page,
  pages,
  workspace,
  paused,
  onHome,
  onOutline,
  onSubpage,
  onDirty,
  onSaved,
  onRefresh,
  onDeleted,
  onSchedule,
  onThread,
  onSettings,
  onCreateDot,
}: {
  page: Page;
  pages: Page[];
  workspace: WorkspaceState;
  paused: boolean;
  onHome: () => void;
  onOutline: () => void;
  onSubpage: () => void;
  onDirty: (value: boolean) => void;
  onSaved: (page: Page) => void;
  onRefresh: () => void;
  onDeleted: (id: string) => void;
  onSchedule: (id: string) => void;
  onThread: (id: string) => void;
  onSettings: () => void;
  onCreateDot: () => void;
}) {
  const { controller, state } = usePageAutosave(page, onSaved);
  const draft = state.draft!;
  const [source, setSource] = useState(false);
  const [move, setMove] = useState(false);
  const [notice, setNotice] = useState('');
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const [chatOpen, setChatOpen] = useState(false);
  const safety = useMemo(() => inspectMarkdown(draft.content), [draft.content]);
  const sourceMode = source || !safety.supported;
  useEffect(() => {
    onDirty(controller.dirty);
    return () => onDirty(false);
  }, [state, controller, onDirty]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (controller.dirty) event.preventDefault();
    };
    const save = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 's' &&
        !event.isComposing
      ) {
        event.preventDefault();
        void controller.flush(true);
      }
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('keydown', save);
    return () => {
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('keydown', save);
    };
  }, [controller]);
  const beforeChat = useCallback(() => controller.flush(true), [controller]);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([draft.content], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${draft.title.replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 80) || 'page'}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const latest = async () => {
    if (
      !window.confirm(
        'Load the latest saved page and replace this draft? Download your draft first if you want to keep it.',
      )
    )
      return;
    try {
      controller.receive(
        await api<Page>(`/spaces/${page.spaceId}/pages/${page.id}`),
      );
      controller.useLatest();
      setNotice('');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not load the latest page. Your draft is unchanged.',
      );
    }
  };
  const descendants = new Set([page.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of pages)
      if (
        item.parentId &&
        descendants.has(item.parentId) &&
        !descendants.has(item.id)
      ) {
        descendants.add(item.id);
        changed = true;
      }
  }
  const status =
    state.status === 'saving'
      ? 'Saving…'
      : state.status === 'saved'
        ? 'All changes saved'
        : state.status === 'dirty'
          ? 'Unsaved changes'
          : state.status === 'conflict'
            ? 'Changes need review'
            : 'Could not save';
  return (
    <section
      className={`document-session ${chatOpen ? 'chat-visible' : ''}`}
      aria-label="Document workspace"
    >
      <div className="document-column">
        <header className="document-topbar">
          <button className="document-back" onClick={onHome}>
            <ArrowLeft size={16} />
            <span>All pages</span>
          </button>
          <button
            className="document-icon"
            aria-label="Toggle page outline"
            onClick={onOutline}
          >
            <PanelLeft size={17} />
          </button>
          <span
            className={`document-save-status ${state.status}`}
            role="status"
            aria-live="polite"
          >
            {state.status === 'saved' ? (
              <Check size={13} />
            ) : state.status === 'saving' ? (
              <LoaderCircle size={13} className="saving-spinner" />
            ) : null}
            {status}
          </span>
          <DocumentMenu
            items={[
              {
                label: 'Save now · ⌘/Ctrl S',
                action: () => void controller.flush(true),
              },
              {
                label: sourceMode ? 'Visual editor' : 'Markdown source',
                action: () => {
                  if (sourceMode && !safety.supported) {
                    setNotice(
                      safety.reason ?? 'This document needs source mode.',
                    );
                    return;
                  }
                  setSource(!sourceMode);
                },
              },
              { label: 'Move page', action: () => setMove(!move) },
              { label: 'New subpage', action: onSubpage },
              { label: 'Download Markdown', action: download },
              ...(page.sourceThreadId
                ? [
                    {
                      label: 'Open source conversation',
                      action: () => onThread(page.sourceThreadId!),
                    },
                  ]
                : []),
              {
                label: 'Move to Trash',
                action: async () => {
                  if (
                    !window.confirm(
                      `Move "${draft.title || 'Untitled'}" to Trash? You can restore it from the Space library. Any subpages will move to this page's parent.`,
                    )
                  )
                    return;
                  try {
                    await api(
                      `/spaces/${page.spaceId}/pages/${page.id}`,
                      'DELETE',
                    );
                    onDeleted(page.id);
                    onRefresh();
                    // A slow DELETE can finish after the user opened another
                    // page: only leave, and drop the pending autosave, if this
                    // document is still the one on screen.
                    if (open.current) {
                      controller.dispose();
                      onDirty(false);
                      onHome();
                    }
                  } catch (error) {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : 'Could not delete page.',
                    );
                  }
                },
              },
            ]}
          />
        </header>
        <div className="document-scroll">
          <article className="document-reading-column">
            {state.error && (
              <div
                className={`document-save-notice ${state.status}`}
                role="alert"
              >
                <p>{state.error}</p>
                <div>
                  {state.status === 'error' && (
                    <button onClick={() => void controller.flush(true)}>
                      Retry save
                    </button>
                  )}
                  <button onClick={download}>Download draft</button>
                  {state.status === 'conflict' && (
                    <button onClick={() => void latest()}>Load latest</button>
                  )}
                </div>
              </div>
            )}
            {notice && (
              <div className="document-notice" role="status">
                {notice}
                <button onClick={() => setNotice('')}>Dismiss</button>
              </div>
            )}
            {move && (
              <div
                className="document-move"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setMove(false);
                }}
              >
                <label>
                  Move under
                  <select
                    autoFocus
                    aria-label="Parent page"
                    value={draft.parentId ?? ''}
                    onChange={(e) =>
                      controller.edit({ parentId: e.target.value || null })
                    }
                  >
                    <option value="">Space root</option>
                    {pages
                      .filter((p) => !descendants.has(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                  </select>
                </label>
                <button onClick={() => setMove(false)}>Done</button>
              </div>
            )}
            <PageHistory
              page={page}
              onRestored={(next) => {
                controller.receive(next);
                controller.useLatest();
                onSaved(next);
                setNotice('');
              }}
            />
            <input
              className="document-title"
              aria-label="Page title"
              placeholder="Untitled page"
              maxLength={160}
              value={draft.title}
              onChange={(event) =>
                controller.edit({ title: event.target.value })
              }
            />
            {sourceMode ? (
              <>
                <div className="source-mode-label">
                  <FileCode2 size={15} />
                  <span>Markdown source</span>
                </div>
                {!safety.supported && (
                  <p className="source-mode-reason">{safety.reason}</p>
                )}
                <textarea
                  className="document-source"
                  aria-label="Page Markdown"
                  spellCheck={false}
                  value={draft.content}
                  maxLength={100000}
                  onChange={(event) =>
                    controller.edit({ content: event.target.value })
                  }
                />
              </>
            ) : (
              <Suspense
                fallback={<div className="editor-loading">Loading editor…</div>}
              >
                <RichEditor
                  value={draft.content}
                  onChange={(content) => controller.edit({ content })}
                  onNotice={setNotice}
                />
              </Suspense>
            )}
          </article>
        </div>
      </div>
      <div className={`document-assistant ${chatOpen ? 'open' : ''}`}>
        <PageConversation
          page={page}
          workspace={workspace}
          paused={paused}
          beforeChat={beforeChat}
          onRefresh={onRefresh}
          onSchedule={onSchedule}
          onSettings={onSettings}
          onCreateDot={onCreateDot}
          onOpenChange={setChatOpen}
        />
      </div>
    </section>
  );
}
