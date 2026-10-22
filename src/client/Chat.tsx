import { PageReviewCard } from './PageReviewCard';
import { executionReceipt as summarizeExecution } from '../shared/execution-receipt';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Paperclip,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [attachments, setAttachments] = useState<
    { name: string; path: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Attachments are saved on this PC; the Dot opens them with its local tools.
  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      for (const file of [...files]) {
        if (file.size > 20_000_000)
          throw new Error(`${file.name} is larger than 20 MB.`);
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () =>
            reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        const saved = await api<{ name: string; path: string }>(
          '/uploads',
          'POST',
          { name: file.name, type: file.type || 'text/plain', data },
        );
        setAttachments((current) => [...current, saved]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Attachment failed.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const [error, setError] = useState('');
  const [turnError, setTurnError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  const [executionReceipt, setExecutionReceipt] = useState('');
  // Status of messages sent to a task while it runs (see steer below).
  const [steerNote, setSteerNote] = useState('');
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!/network|fetch|connection/i.test(error) || connectAttempt >= 3) return;
    // Reattach to the persisted run; never resubmit a prompt or replay actions.
    const timer = setTimeout(
      () => setConnectAttempt((value) => value + 1),
      1000 * 2 ** connectAttempt,
    );
    return () => clearTimeout(timer);
  }, [error, connectAttempt]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    const events = agent.subscribe({
      onMessagesSnapshotEvent: () => setLoaded(true),
      onRunStartedEvent: () => {
        setLoaded(true);
        setRunning(true);
        setError('');
        setTurnError(false);
      },
      onRunFinishedEvent: () => {
        setRunning(false);
        setSteerNote('');
      },
      // A steered message lands in the transcript as the owner's message.
      onTextMessageStartEvent: ({ event }) => {
        if (event.role === 'user') setSteerNote('');
      },
      onRunErrorEvent: ({ event }) => {
        setRunning(false);
        setSteerNote('');
        setTurnError(true);
        setError(event.message);
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) {
          setLoaded(true);
          setError((current) =>
            /network|fetch|connection/i.test(current) ? '' : current,
          );
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady, connectAttempt]);
  // While a task runs, a message goes to that task instead of being dropped;
  // the task reads it after its current tool step and keeps going.
  const steer = async (text: string) => {
    try {
      const { waiting } = await api<{ waiting: number }>(
        `/threads/${encodeURIComponent(thread.id)}/steer`,
        'POST',
        { text },
      );
      setDraft('');
      setAttachments([]);
      setSource('');
      setSourceOpen(false);
      setSteerNote(
        waiting > 1
          ? `${waiting} messages sent to the running task. It reads them after its current step.`
          : 'Sent to the running task. It reads it after its current step.',
      );
    } catch (e) {
      setSteerNote(
        e instanceof Error ? e.message : 'Could not reach the running task.',
      );
    }
  };
  const send = async (typed: string) => {
    const text = attachments.length
      ? `${typed.trim() || 'Please look at the attached file(s).'}\n\nAttached files (open them with your tools):\n${attachments
          .map((file) => `- ${file.name}: ${file.path}`)
          .join('\n')}`
      : typed;
    if (running && loaded && !paused && text.trim()) {
      await steer(text);
      return;
    }
    if (!text.trim() || running || !loaded || !contextReady || paused) return;
    setAttachments([]);
    setError('');
    setTurnError(false);
    setRunning(true);
    setExecutionReceipt('');
    agent.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    setDraft('');
    setSource('');
    setSourceOpen(false);
    try {
      const result = await copilotkit.runAgent({ agent });
      setExecutionReceipt(summarizeExecution(result.newMessages));
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              call.function.name === pageReviewTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        {!running && executionReceipt && (
          <p role="status" className="muted">
            {executionReceipt}
          </p>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && (!turnError || /network|fetch|connection/i.test(error)) && (
            <button
              onClick={() => {
                setError('');
                setTurnError(false);
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <form
        className="chat-composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void attach(e.dataTransfer.files);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-list">
            {attachments.map((file) => (
              <span
                className="attachment-chip"
                key={file.path}
                title={file.path}
              >
                <Paperclip size={13} />
                {file.name}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setAttachments(
                      attachments.filter((item) => item.path !== file.path),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-compose-row">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,.txt,.md,.csv,.json,.pdf"
            onChange={(e) => void attach(e.target.files)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Attach files"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={19} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running && (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => copilotkit.stopAgent({ agent })}
            >
              <Square size={16} />
            </button>
          )}
          {(!running || draft.trim() || attachments.length > 0) && (
            <button
              className="send-button"
              aria-label={running ? 'Send to the running task' : 'Send message'}
              title={
                running
                  ? 'The task reads this after its current step and keeps going'
                  : undefined
              }
              disabled={
                (!draft.trim() && !attachments.length) ||
                uploading ||
                !loaded ||
                (!running && !contextReady) ||
                paused
              }
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        {steerNote && (
          <div className="chat-compose-note" role="status">
            {steerNote}
          </div>
        )}
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
