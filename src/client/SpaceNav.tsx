import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import type { Space } from '../shared/types';
import type { Page } from '../server/pages';
import { api } from './api';
import { localizedStarterSpaceName, t } from './i18n';

export function SpaceNav({
  space,
  active,
  pageId,
  onOpen,
}: {
  space: Space;
  active: boolean;
  pageId?: string;
  onOpen: (pageId?: string) => void;
}) {
  const spaceName = localizedStarterSpaceName(space.name);
  const [expanded, setExpanded] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    const load = async () => {
      try {
        const next = await api<Page[]>(`/spaces/${space.id}/pages`);
        if (current) {
          setPages(next);
          setError('');
        }
      } catch {
        if (current) setError(t('pages.loadError'));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [expanded, space.id]);
  const branches = (parentId: string | null, depth = 0): React.ReactNode =>
    pages
      .filter((page) => page.parentId === parentId)
      .map((page) => (
        <div key={page.id}>
          <button
            className={`nav-item space-page-link ${active && pageId === page.id ? 'active' : ''}`}
            style={{ paddingLeft: 28 + depth * 12 }}
            aria-current={active && pageId === page.id ? 'page' : undefined}
            onClick={() => onOpen(page.id)}
          >
            <FileText size={14} />
            <span>{page.title}</span>
          </button>
          {branches(page.id, depth + 1)}
        </div>
      ));
  return (
    <div className="space-nav-group">
      <div className="space-nav-row">
        <button
          className="icon-button space-disclosure"
          aria-label={(expanded
            ? t('nav.collapseSpace')
            : t('nav.expandSpace')
          ).replace('{name}', spaceName)}
          aria-expanded={expanded}
          aria-controls={`space-pages-${space.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            size={13}
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          />
        </button>
        <button
          className={`nav-item ${active && !pageId ? 'active' : ''}`}
          aria-current={active && !pageId ? 'page' : undefined}
          onClick={() => onOpen()}
        >
          <Folder size={16} />
          <span>{spaceName}</span>
        </button>
      </div>
      {expanded && (
        <div id={`space-pages-${space.id}`}>
          {error ? (
            <p className="sidebar-error" role="status">
              {error}
            </p>
          ) : (
            branches(null)
          )}
          {!error && !pages.length && (
            <p className="sidebar-empty">{t('pages.noneYet')}</p>
          )}
        </div>
      )}
    </div>
  );
}
