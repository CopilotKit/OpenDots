import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Download, Trash2, Upload } from 'lucide-react';
import type { Page } from '../server/pages';
import { api } from './api';

export function SpaceTrash({
  spaceId,
  onChanged,
}: {
  spaceId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [trash, setTrash] = useState<Page[] | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setTrash(await api<Page[]>(`/spaces/${spaceId}/trash`));
      setNotice('');
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not load trash.',
      );
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open, spaceId]);

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await api(`/spaces/${spaceId}/trash/${id}/restore`, 'POST');
      await load();
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not restore page.',
      );
    } finally {
      setBusy(false);
    }
  };

  const purge = async (id: string, title: string) => {
    if (
      !window.confirm(
        `Permanently delete "${title}"? This cannot be undone. Export the Space first if you need a backup.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/spaces/${spaceId}/trash/${id}`, 'DELETE');
      await load();
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not delete page.',
      );
    } finally {
      setBusy(false);
    }
  };

  const exportSpace = async () => {
    try {
      const data = await api<{
        version: number;
        exportedAt: number;
        spaceId: string;
        pages: {
          id: string;
          parentId: string | null;
          title: string;
          content: string;
        }[];
      }>(`/spaces/${spaceId}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], {
          type: 'application/json;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `space-export-${new Date(data.exportedAt).toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not export Space.',
      );
    }
  };

  const importSpace = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        pages?: {
          id?: string;
          title: string;
          content?: string;
          parentId?: string | null;
        }[];
      };
      if (!Array.isArray(parsed.pages))
        throw new Error('That file is not a Space export (missing "pages").');
      await api(`/spaces/${spaceId}/import`, 'POST', { pages: parsed.pages });
      setNotice(
        `Imported ${parsed.pages.length} page${parsed.pages.length === 1 ? '' : 's'}.`,
      );
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not import file.',
      );
    }
  };

  return (
    <section className="space-trash" aria-label="Trash and backup">
      <div className="space-trash-row">
        <button
          className="space-trash-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ArchiveRestore size={15} />
          <span>Trash{trash?.length ? ` (${trash.length})` : ''}</span>
        </button>
        <div className="space-trash-actions">
          <button
            onClick={() => void exportSpace()}
            title="Download this Space as JSON"
          >
            <Download size={15} /> Export
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="Import a Space JSON export"
          >
            <Upload size={15} /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Import Space JSON"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importSpace(file);
            }}
          />
        </div>
      </div>
      {open && (
        <div className="space-trash-panel">
          {!trash && <p className="page-history-empty">Loading trash…</p>}
          {trash?.length === 0 && (
            <p className="page-history-empty">
              Trash is empty. Deleted pages stay here until you restore or
              permanently delete them.
            </p>
          )}
          {!!trash?.length && (
            <ul className="space-trash-list">
              {trash!.map((page) => (
                <li key={page.id}>
                  <div>
                    <strong>{page.title}</strong>
                    <span>
                      {' '}
                      Deleted{' '}
                      {page.deletedAt
                        ? new Date(page.deletedAt).toLocaleDateString(
                            undefined,
                            {
                              month: 'short',
                              day: 'numeric',
                            },
                          )
                        : 'recently'}
                    </span>
                  </div>
                  <div className="space-trash-item-actions">
                    <button
                      disabled={busy}
                      onClick={() => void restore(page.id)}
                    >
                      <ArchiveRestore size={14} /> Restore
                    </button>
                    <button
                      disabled={busy}
                      className="danger"
                      onClick={() => void purge(page.id, page.title)}
                    >
                      <Trash2 size={14} /> Delete forever
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {notice && (
            <p className="page-history-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      )}
      {!open && notice && (
        <p className="page-history-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
