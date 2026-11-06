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
import { dateLocale, t, tp } from './i18n';
export function pageExcerpt(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/```[\s\S]*?```/g, t('Code block'))
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
      aria-label={t('{name} page library', { name: space.name })}
    >
      <header className="library-heading">
        <div>
          <span className="library-eyebrow">{t('SPACE')}</span>
          <h1>{space.name}</h1>
          {space.description && <p>{space.description}</p>}
        </div>
        <button className="document-primary" onClick={onNew}>
          <Plus size={17} /> {t('New page')}
        </button>
      </header>
      <div className="library-tools">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label={t('Search pages')}
            placeholder={t('Search pages')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="library-sort">
          <span className="sr-only">{t('Sort pages')}</span>
          <select
            aria-label={t('Sort pages')}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">{t('Recently edited')}</option>
            <option value="name">{t('Name A–Z')}</option>
          </select>
        </label>
        <div
          className="library-view-toggle"
          role="group"
          aria-label={t('Library view')}
        >
          <button
            aria-label={t('Grid view')}
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label={t('List view')}
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      <div className="library-section-label">
        <h2>{query ? t('Search results') : t('All pages')}</h2>
        <span>{tp('{count} page|{count} pages', filtered.length)}</span>
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
                <p>
                  {pageExcerpt(page.content) ||
                    t('An empty page, ready to write.')}
                </p>
                <div className="library-page-meta">
                  <span title={new Date(page.updatedAt).toLocaleString()}>
                    {t('Edited {date}', {
                      date: new Date(page.updatedAt).toLocaleDateString(
                        dateLocale,
                        { month: 'short', day: 'numeric' },
                      ),
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
          <h2>{query ? t('No matching pages') : t('No pages yet')}</h2>
          <p>
            {query
              ? t('Try a different title or phrase.')
              : t('Create your first page to start organizing this Space.')}
          </p>
          {!query && (
            <button className="document-primary" onClick={onNew}>
              <Plus size={16} /> {t('New page')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
