import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { Conversation, Dot } from '../shared/types';
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  onSelect,
  onNew,
  onDelete,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete?: (id: string) => void;
}) {
  // Which chats still have a reply running (unattended tasks keep going in the
  // background until they finish or are stopped).
  const [running, setRunning] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void api<{ ids: string[] }>('/conversations/running')
        .then((data) => live && setRunning(data.ids))
        .catch(() => undefined);
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
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
        const busy = running.includes(thread.id);
        return (
          <div key={thread.id} className="thread-row">
            <button
              className={`nav-item ${selected === thread.id ? 'active' : ''}`}
              onClick={() => onSelect(thread.id)}
            >
              <MessageCircle size={15} />
              <span className="thread-summary">
                <span>{remote?.name || thread.title}</span>
                <small>
                  {busy && (
                    <span className="thread-running" title="Running now">
                      ● running ·{' '}
                    </span>
                  )}
                  {dots.find((dot) => dot.id === thread.dotId)?.name}
                </small>
              </span>
            </button>
            {onDelete && (
              <button
                className="icon-button thread-delete"
                aria-label={`Delete conversation ${remote?.name || thread.title}`}
                title={busy ? 'Stop and delete this chat' : 'Delete this chat'}
                onClick={() => onDelete(thread.id)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
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
