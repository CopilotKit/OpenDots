import { FileText, Plus, X } from 'lucide-react';
import type { Page } from '../server/pages';
import { t } from './i18n/pt-BR';
export function PageOutline({
  pages,
  selected,
  onPage,
  onNew,
  onClose,
}: {
  pages: Page[];
  selected: string;
  onPage: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const render = (parentId: string | null, depth = 0): React.ReactNode =>
    pages
      .filter((page) => page.parentId === parentId)
      .map((page) => (
        <li key={page.id}>
          <button
            style={{ paddingLeft: 12 + depth * 12 }}
            aria-current={selected === page.id ? 'page' : undefined}
            onClick={() => onPage(page.id)}
          >
            <FileText size={14} />
            <span>{page.title}</span>
          </button>
          {pages.some((child) => child.parentId === page.id) && (
            <ul>{render(page.id, depth + 1)}</ul>
          )}
        </li>
      ));
  return (
    <nav className="document-outline" aria-label={t('editor.pagesInSpace')}>
      <div>
        <strong>{t('editor.pages')}</strong>
        <button
          className="document-icon"
          aria-label={t('editor.newPageOutline')}
          onClick={onNew}
        >
          <Plus size={16} />
        </button>
        <button
          className="document-icon"
          aria-label={t('editor.closeOutline')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <ul>{render(null)}</ul>
    </nav>
  );
}
