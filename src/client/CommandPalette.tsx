import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  FileText,
  Folder,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type { SearchResults } from '../server/search';
import type { WorkspaceState } from '../shared/types';
import { api } from './api';

interface PaletteItem {
  key: string;
  group: string;
  label: string;
  detail: string;
  run: () => void;
}

export function CommandPalette({
  open,
  spaceId,
  workspace,
  onClose,
  onOpenPage,
  onOpenSpace,
  onNewPage,
  onNewSpace,
  onOpenDot,
}: {
  open: boolean;
  spaceId: string;
  workspace: WorkspaceState;
  onClose: () => void;
  onOpenPage: (space: string, page: string) => void;
  onOpenSpace: (space: string) => void;
  onNewPage: () => void;
  onNewSpace: () => void;
  onOpenDot: (dotId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(null);
      setNotice('');
      setActive(0);
      const focus = () => inputRef.current?.focus();
      if (typeof requestAnimationFrame === 'function')
        requestAnimationFrame(focus);
      else focus();
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      abortRef.current?.abort();
      setResults(null);
      setLoading(false);
      setActive(0);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      api<SearchResults>(
        `/search?q=${encodeURIComponent(trimmed)}&limit=20`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((rows) => {
          setResults(rows);
          setNotice('');
          setActive(0);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError')
            return;
          setNotice(error instanceof Error ? error.message : 'Search failed.');
        })
        .finally(() => setLoading(false));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  const commands: PaletteItem[] = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const all: PaletteItem[] = [
      {
        key: 'cmd-new-page',
        group: 'Commands',
        label: 'New page in this Space',
        detail: workspace.spaces.find((s) => s.id === spaceId)?.name ?? '',
        run: onNewPage,
      },
      {
        key: 'cmd-new-space',
        group: 'Commands',
        label: 'New Space',
        detail: 'Organize a new area',
        run: onNewSpace,
      },
      {
        key: 'cmd-go-spaces',
        group: 'Commands',
        label: `Go to ${workspace.spaces.find((s) => s.id === spaceId)?.name ?? 'Space'} library`,
        detail: 'Browse all pages',
        run: () => onOpenSpace(spaceId),
      },
    ];
    if (!needle) return all;
    return all.filter((item) =>
      `${item.label} ${item.detail}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, spaceId, workspace.spaces, onNewPage, onNewSpace, onOpenSpace]);

  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = [];
    for (const page of results?.pages ?? []) {
      list.push({
        key: `page-${page.id}`,
        group: 'Pages',
        label: page.title,
        detail: `${page.spaceName}${page.excerpt ? ` · ${page.excerpt.slice(0, 80)}` : ''}`,
        run: () => onOpenPage(page.spaceId, page.id),
      });
    }
    for (const space of results?.spaces ?? []) {
      list.push({
        key: `space-${space.id}`,
        group: 'Spaces',
        label: space.name,
        detail: space.description.slice(0, 80),
        run: () => onOpenSpace(space.id),
      });
    }
    for (const dot of results?.dots ?? []) {
      list.push({
        key: `dot-${dot.id}`,
        group: 'Dots',
        label: dot.name,
        detail: dot.instructions.slice(0, 80),
        run: () => onOpenDot(dot.id),
      });
    }
    return [...list, ...commands];
  }, [results, commands, onOpenPage, onOpenSpace, onOpenDot]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(items.length - 1, 0)));
  }, [items.length]);

  if (!open) return null;

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (items.length ? (current + 1) % items.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) =>
        items.length ? (current - 1 + items.length) % items.length : 0,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="palette-input-row">
          <Search size={17} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={items[active]?.key}
            aria-label="Search pages, Spaces, Dots, and commands"
            placeholder="Search pages, Spaces, Dots, or type a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <div
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="palette-results"
          onKeyDown={onKeyDown}
        >
          {loading && <p className="palette-hint">Searching…</p>}
          {!loading && query.trim().length < 2 && (
            <p className="palette-hint">
              Type at least 2 characters to search across Spaces. Use ↑ ↓ and
              Enter.
            </p>
          )}
          {!loading &&
            query.trim().length >= 2 &&
            items.length === 0 &&
            !notice && (
              <div className="palette-empty">
                <FileText size={26} strokeWidth={1.4} />
                <p>No matches for “{query.trim()}”.</p>
                <span>Try a title word, a Space name, or a Dot name.</span>
              </div>
            )}
          {items.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && <p className="palette-group">{header}</p>}
                <button
                  id={item.key}
                  role="option"
                  aria-selected={index === active}
                  className={`palette-item ${index === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span className="palette-item-icon">
                    {item.group === 'Pages' ? (
                      <FileText size={15} />
                    ) : item.group === 'Spaces' ? (
                      <Folder size={15} />
                    ) : item.group === 'Dots' ? (
                      <Sparkles size={15} />
                    ) : (
                      <Plus size={15} />
                    )}
                  </span>
                  <span className="palette-item-text">
                    <strong>{item.label}</strong>
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                  <ArrowRight size={14} className="palette-item-arrow" />
                </button>
              </div>
            );
          })}
        </div>
        {notice && (
          <p className="palette-notice" role="status">
            {notice}
          </p>
        )}
        <footer className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
