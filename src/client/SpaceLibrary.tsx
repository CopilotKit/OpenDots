import { useMemo, useState } from 'react';
import {
  FileText,
  Plus,
  Search,
  LayoutGrid,
  List,
  ArrowUpRight,
} from 'lucide-react';
import type { Page } from '../server/pages';
import type { Space } from '../shared/types';
import {
  localizedStarterSpaceDescription,
  localizedStarterSpaceName,
  t,
} from './i18n';
export function pageExcerpt(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/```[\s\S]*?```/g, t('editor.codeBlock'))
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
export function SpaceLibrary({
  space,
  pages,
  onPage,
  onNew,
}: {
  space: Space;
  pages: Page[];
  onPage: (id: string) => void;
  onNew: () => void;
}) {
  const spaceName = localizedStarterSpaceName(space.name);
  const spaceDescription = localizedStarterSpaceDescription(space.description);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const filtered = useMemo(
    () =>
      pages
        .filter((page) =>
          `${page.title} ${page.content}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title)
            : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
        ),
    [pages, query, sort],
  );
  return (
    <section
      className="space-library"
      aria-label={t('pages.libraryLabel').replace('{name}', spaceName)}
    >
      <header className="library-heading">
        <div>
          <span className="library-eyebrow">{t('pages.space')}</span>
          <h1>{spaceName}</h1>
          {spaceDescription && <p>{spaceDescription}</p>}
        </div>
        <button className="document-primary" onClick={onNew}>
          <Plus size={17} /> {t('pages.new')}
        </button>
      </header>
      <div className="library-tools">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label={t('pages.search')}
            placeholder={t('pages.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="library-sort">
          <span className="sr-only">{t('pages.sort')}</span>
          <select
            aria-label={t('pages.sort')}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">{t('pages.recentlyEdited')}</option>
            <option value="name">{t('pages.nameAZ')}</option>
          </select>
        </label>
        <div
          className="library-view-toggle"
          role="group"
          aria-label={t('pages.libraryView')}
        >
          <button
            aria-label={t('pages.gridView')}
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label={t('pages.listView')}
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      <div className="library-section-label">
        <h2>{query ? t('pages.results') : t('pages.all')}</h2>
        <span>
          {filtered.length}{' '}
          {filtered.length === 1
            ? t('pages.pageSingular')
            : t('pages.pagePlural')}
        </span>
      </div>
      {filtered.length ? (
        <div className={`library-pages ${layout}`}>
          {filtered.map((page) => (
            <button
              className="library-page-card"
              key={page.id}
              onClick={() => onPage(page.id)}
            >
              <span className="library-page-icon">
                <FileText size={20} strokeWidth={1.5} />
              </span>
              <div className="library-card-body">
                <h3>{page.title}</h3>
                <p>{pageExcerpt(page.content) || t('pages.empty')}</p>
                <div className="library-page-meta">
                  <span title={new Date(page.updatedAt).toLocaleString()}>
                    {t('pages.edited')}{' '}
                    {new Date(page.updatedAt).toLocaleDateString('pt-BR', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  {page.parentId && (
                    <span className="library-parent">
                      {
                        pages.find((parent) => parent.id === page.parentId)
                          ?.title
                      }
                    </span>
                  )}
                </div>
              </div>
              <ArrowUpRight className="library-card-arrow" size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <FileText size={30} strokeWidth={1.3} />
          <h2>{query ? t('pages.noneFound') : t('pages.noneYet')}</h2>
          <p>{query ? t('pages.tryAnotherSearch') : t('pages.firstPage')}</p>
          {!query && (
            <button className="document-primary" onClick={onNew}>
              <Plus size={16} /> {t('pages.new')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
