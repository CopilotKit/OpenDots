import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Plus } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
import { t } from './i18n/pt-BR';
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  onSelect,
  onNew,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const threads = useThreads({
    agentId: dotId,
    enabled: true,
    includeArchived: false,
    limit: 20,
  });
  return (
    <section className="thread-list">
      <div className="nav-label">
        {t('nav.recentConversations')}
        <button
          className="icon-button"
          onClick={onNew}
          aria-label={t('nav.newConversation')}
        >
          <Plus size={14} />
        </button>
      </div>
      {threads.error && <p className="sidebar-error">{t('nav.syncError')}</p>}
      {local.map((thread) => {
        const remote = threads.threads.find((item) => item.id === thread.id);
        return (
          <button
            key={thread.id}
            className={`nav-item ${selected === thread.id ? 'active' : ''}`}
            onClick={() => onSelect(thread.id)}
          >
            <MessageCircle size={15} />
            <span className="thread-summary">
              <span>{remote?.name || thread.title}</span>
              <small>{dots.find((dot) => dot.id === thread.dotId)?.name}</small>
            </span>
          </button>
        );
      })}
      {!local.length && (
        <p className="sidebar-empty">{t('nav.firstConversation')}</p>
      )}
      {threads.hasMoreThreads && (
        <button
          className="text-button"
          disabled={threads.isFetchingMoreThreads}
          onClick={() => void threads.fetchMoreThreads()}
        >
          {t('nav.loadMore')}
        </button>
      )}
    </section>
  );
}
