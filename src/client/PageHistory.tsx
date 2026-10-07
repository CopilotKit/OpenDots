import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { Page, PageVersion } from '../server/pages';
import { api, ApiError } from './api';

export function PageHistory({
  page,
  onRestored,
}: {
  page: Page;
  onRestored: (page: Page) => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || versions !== null) return;
    let active = true;
    setLoading(true);
    api<PageVersion[]>(`/spaces/${page.spaceId}/pages/${page.id}/versions`)
      .then((rows) => {
        if (active) {
          setVersions(rows);
          setSelectedId(rows[0]?.id ?? null);
          setNotice('');
        }
      })
      .catch((error) => {
        if (active)
          setNotice(
            error instanceof Error
              ? error.message
              : 'Could not load page history.',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, versions, page.spaceId, page.id]);

  // A new revision means the cached list is stale; refetch on next open.
  useEffect(() => {
    setVersions(null);
    setSelectedId(null);
  }, [page.revision]);

  const selected = versions?.find((item) => item.id === selectedId) ?? null;

  const restore = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        `Restore "${selected.title}" from revision ${selected.revision}? Your current draft is kept as a new history entry.`,
      )
    )
      return;
    try {
      const next = await api<Page>(
        `/spaces/${page.spaceId}/pages/${page.id}/restore`,
        'POST',
        { versionId: selected.id, expectedRevision: page.revision },
      );
      onRestored(next);
      setNotice(`Restored revision ${selected.revision}.`);
      setVersions(null);
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 409
          ? 'This page changed. Reload the latest revision before restoring.'
          : error instanceof Error
            ? error.message
            : 'Could not restore this version.',
      );
    }
  };

  return (
    <div className="page-history">
      <button
        className="page-history-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <History size={15} />
        <span>History</span>
      </button>
      {open && (
        <div
          className="page-history-panel"
          role="region"
          aria-label="Page history"
        >
          {loading && <p className="page-history-empty">Loading history…</p>}
          {!loading && versions?.length === 0 && (
            <p className="page-history-empty">
              No earlier revisions yet. Edit and save this page to create the
              first history entry.
            </p>
          )}
          {!!versions?.length && (
            <div className="page-history-layout">
              <ul className="page-history-list">
                {versions!.map((item) => (
                  <li key={item.id}>
                    <button
                      className={item.id === selectedId ? 'selected' : ''}
                      onClick={() => setSelectedId(item.id)}
                      aria-pressed={item.id === selectedId}
                    >
                      <strong>r{item.revision}</strong>
                      <span>{item.title}</span>
                      <time title={new Date(item.createdAt).toLocaleString()}>
                        {new Date(item.createdAt).toLocaleDateString(
                          undefined,
                          {
                            month: 'short',
                            day: 'numeric',
                          },
                        )}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
              {selected && (
                <div className="page-history-preview">
                  <h4>{selected.title}</h4>
                  <p className="page-history-meta">
                    Revision {selected.revision} ·{' '}
                    {new Date(selected.createdAt).toLocaleString()}
                  </p>
                  <pre>{selected.content.slice(0, 2000)}</pre>
                  {selected.content.length > 2000 && (
                    <p className="page-history-meta">
                      Preview truncated at 2,000 of{' '}
                      {selected.content.length.toLocaleString()} characters.
                    </p>
                  )}
                  <button
                    className="document-primary"
                    onClick={() => void restore()}
                  >
                    <RotateCcw size={14} /> Restore this version
                  </button>
                </div>
              )}
            </div>
          )}
          {notice && (
            <p className="page-history-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
