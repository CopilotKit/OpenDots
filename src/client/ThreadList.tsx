import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Plus } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  removing,
  onSelect,
  onNew,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  /** Thread id currently being deleted; the item fades out while it goes. */
  removing?: string;
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
        RECENT CHATS
        <button
          className="icon-button"
          onClick={onNew}
          aria-label="New conversation"
        >
          <Plus size={14} />
        </button>
      </div>
      {threads.error && (
        <p className="sidebar-error">
          Conversation sync unavailable. Check your runtime connection.
        </p>
      )}
      {local.map((thread) => {
        const remote = threads.threads.find((item) => item.id === thread.id);
        return (
          <button
            key={thread.id}
            className={`nav-item ${selected === thread.id ? 'active' : ''} ${removing === thread.id ? 'removing' : ''}`}
            onClick={() => onSelect(thread.id)}
            disabled={removing === thread.id}
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
        <p className="sidebar-empty">Your first conversation will live here.</p>
      )}
      {threads.hasMoreThreads && (
        <button
          className="text-button"
          disabled={threads.isFetchingMoreThreads}
          onClick={() => void threads.fetchMoreThreads()}
        >
          Load more conversations
        </button>
      )}
    </section>
  );
}
