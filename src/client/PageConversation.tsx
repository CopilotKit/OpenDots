import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, X, MessageCircle } from 'lucide-react';
import type { Conversation, WorkspaceState } from '../shared/types';
import type { Page } from '../server/pages';
import { Chat } from './Chat';
import { PageChatRequests } from './page-chat-requests';
import { api } from './api';
import { t } from './i18n/pt-BR';
export function PageConversation({
  page,
  workspace,
  paused,
  beforeChat,
  onRefresh,
  onSchedule,
  onSettings,
  onCreateDot,
  onOpenChange,
}: {
  page: Page;
  workspace: WorkspaceState;
  paused: boolean;
  beforeChat: () => Promise<boolean>;
  onRefresh: () => void;
  onSchedule: (id: string) => void;
  onSettings: () => void;
  onCreateDot: () => void;
  onOpenChange: (value: boolean) => void;
}) {
  const dots = workspace.dots.filter((dot) =>
    dot.spaceIds.includes(page.spaceId),
  );
  const [dotId, setDotId] = useState('');
  const dot = dots.find((dot) => dot.id === dotId) ?? dots[0];
  const [thread, setThread] = useState<Conversation>();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = useRef(new PageChatRequests());
  const scope = `${page.id}:${dot?.id ?? ''}`;
  requests.current.select(scope);
  useEffect(() => {
    setThread(undefined);
    setPending(undefined);
    setBusy(false);
    onOpenChange(false);
  }, [scope, onOpenChange]);
  useEffect(() => {
    const current = requests.current;
    return () => current.select('');
  }, []);
  const open = async () => {
    if (!dot || busy) return;
    setBusy(true);
    setError('');
    const prompt = draft.trim();
    await requests.current.run(
      scope,
      async () => {
        if (!(await beforeChat()))
          throw new Error(
            'Salve ou resolva as alterações do documento antes de iniciar uma conversa sobre a página.',
          );
        return api<Conversation>(
          `/spaces/${page.spaceId}/pages/${page.id}/conversation`,
          'POST',
          { dotId: dot.id },
        );
      },
      {
        success: (next) => {
          setThread(next);
          setPending(prompt || undefined);
          setDraft('');
          onOpenChange(true);
          onRefresh();
        },
        failure: (e) =>
          setError(
            e instanceof Error
              ? e.message
              : 'Não foi possível abrir a conversa sobre a página.',
          ),
        settled: () => setBusy(false),
      },
    );
  };
  if (thread && dot && thread.dotId === dot.id)
    return (
      <aside className="document-chat-panel" aria-label={t('pageChat.title')}>
        <div className="document-chat-heading">
          <span>
            <MessageCircle size={16} /> {t('pageChat.title')}
          </span>
          <button
            className="document-icon"
            aria-label={t('pageChat.close')}
            onClick={() => {
              setThread(undefined);
              onOpenChange(false);
            }}
          >
            <X size={17} />
          </button>
        </div>
        <Chat
          key={thread.id}
          thread={thread}
          dot={dot}
          initialPrompt={pending}
          onConsumed={() => setPending(undefined)}
          voiceReady={workspace.setup.voice}
          calls={workspace.calls.filter((call) => call.threadId === thread.id)}
          paused={paused}
          onSaved={onRefresh}
          onSchedule={() => onSchedule(thread.id)}
        />
      </aside>
    );
  if (!dot)
    return (
      <div className="document-chat-setup">
        <span>{t('pageChat.addAgent')}</span>
        <button onClick={onCreateDot}>{t('pageChat.createAgent')}</button>
      </div>
    );
  if (workspace.setup.missing.length)
    return (
      <div className="document-chat-setup">
        <span>{t('pageChat.connectAgent')}</span>
        <button onClick={onSettings}>{t('pageChat.setupAgent')}</button>
      </div>
    );
  return (
    <div className="document-chat-dock">
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <label className="sr-only" htmlFor="page-prompt">
          {t('pageChat.ask')}
        </label>
        <input
          id="page-prompt"
          placeholder={t('pageChat.ask')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={paused || busy}
        />
        <div className="document-chat-dock-bottom">
          <label>
            <select
              aria-label={t('pageChat.specialist')}
              disabled={busy}
              value={dot.id}
              onChange={(e) => setDotId(e.target.value)}
            >
              {dots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <span>{paused ? t('pageChat.paused') : t('pageChat.usesPage')}</span>
          <button
            type="submit"
            aria-label={t('pageChat.send')}
            disabled={busy || paused}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
