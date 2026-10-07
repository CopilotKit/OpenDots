import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  defaultApplyEvents,
  EventType,
  type AgentSubscriber,
  type BaseEvent,
  type RunAgentInput,
  type RunAgentParameters,
} from '@ag-ui/client';
import { CopilotKitCore, CopilotKitCoreErrorCode } from '@copilotkit/core';
import { from, lastValueFrom, throwError, toArray } from 'rxjs';

const harness = vi.hoisted(() => {
  type Subscriber = {
    onRunErrorEvent?: (params: {
      event: { type: string; message: string };
    }) => void;
    onRunFinishedEvent?: (params: {
      event: { type: string };
      outcome: 'success' | 'interrupt';
      interrupts?: unknown[];
    }) => void;
    onError?: (params: { error: Error; code: string }) => void;
  };
  const agentSubscribers: Subscriber[] = [];
  const copilotSubscribers: Subscriber[] = [];
  const agent = {
    messages: [],
    state: {},
    pendingInterrupts: [],
    addMessage: vi.fn(),
    subscribe: vi.fn((subscriber: Subscriber) => {
      agentSubscribers.push(subscriber);
      return {
        unsubscribe: () => {
          const index = agentSubscribers.indexOf(subscriber);
          if (index >= 0) agentSubscribers.splice(index, 1);
        },
      };
    }),
  };
  const copilotkit = {
    subscribe: vi.fn((subscriber: Subscriber) => {
      copilotSubscribers.push(subscriber);
      return {
        unsubscribe: () => {
          const index = copilotSubscribers.indexOf(subscriber);
          if (index >= 0) copilotSubscribers.splice(index, 1);
        },
      };
    }),
    connectAgent: vi.fn(async () => ({})),
    runAgent: vi.fn(async () => ({ newMessages: [] })),
    emitError(message: string, code: string) {
      const params = { error: new Error(message), code };
      for (const subscriber of [...copilotSubscribers])
        subscriber.onError?.(params);
    },
  };
  return {
    agent,
    agentSubscribers,
    copilotkit,
    api: vi.fn(async () => null),
    useAgent: vi.fn(() => ({ agent, isReady: true })),
    useCopilotKit: vi.fn(() => ({ copilotkit })),
  };
});

vi.mock('../src/client/api', () => ({ api: harness.api }));
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: vi.fn(),
  useHumanInTheLoop: vi.fn(),
  useAgent: harness.useAgent,
  useCopilotKit: harness.useCopilotKit,
}));
vi.mock('../src/client/PageReviewCard', () => ({ PageReviewCard: () => null }));
vi.mock('../src/client/ComputerToolCard', () => ({
  ComputerToolCard: () => null,
}));
vi.mock('../src/client/ChatTranscript', () => ({
  ChatTranscript: () => null,
  isInternalVoiceReceipt: () => false,
}));
vi.mock('../src/client/Mascot', () => ({ Mascot: () => null }));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle', error: '', end: vi.fn() }),
}));

import { Chat } from '../src/client/Chat';

class ReplayAgent extends AbstractAgent {
  events: BaseEvent[] = [];

  run() {
    return from(this.events);
  }

  // Connect replays can contain several runs; apply them without single-run verification.
  async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ) {
    await lastValueFrom(
      defaultApplyEvents(
        this.prepareRunAgentInput(parameters),
        from(this.events),
        this,
        [...this.subscribers, subscriber ?? {}],
      ).pipe(toArray()),
    );
    return { newMessages: [], result: undefined };
  }
}

function useReplayAgent(events: BaseEvent[]) {
  const agent = new ReplayAgent({
    agentId: 'chat-thread',
    threadId: 'thread',
  });
  const copilotkit = new CopilotKitCore({});
  harness.useAgent.mockReturnValue({
    agent: agent as unknown as typeof harness.agent,
    isReady: true,
  });
  harness.useCopilotKit.mockReturnValue({
    copilotkit: copilotkit as unknown as typeof harness.copilotkit,
  });
  agent.events = events;
  return { agent, copilotkit };
}

function runInput(runId: string): RunAgentInput {
  return {
    threadId: 'thread',
    runId,
    state: {},
    messages: [],
    tools: [],
    context: [],
  };
}

function runStarted(runId: string): BaseEvent {
  return { type: EventType.RUN_STARTED, threadId: 'thread', runId };
}

function runError(runId: string, message: string): BaseEvent[] {
  return [runStarted(runId), { type: EventType.RUN_ERROR, message }];
}

function runFinished(
  runId: string,
  outcome: 'success' | 'interrupt' = 'success',
): BaseEvent[] {
  return [
    runStarted(runId),
    {
      type: EventType.RUN_FINISHED,
      threadId: 'thread',
      runId,
      ...(outcome === 'interrupt'
        ? { outcome: { type: 'interrupt' as const, interrupts: [] } }
        : { outcome: { type: 'success' as const } }),
    },
  ];
}

async function applySdkEvents(events: BaseEvent[]) {
  const started = events.find(
    (
      event,
    ): event is BaseEvent & {
      type: typeof EventType.RUN_STARTED;
      runId: string;
    } =>
      event.type === EventType.RUN_STARTED &&
      'runId' in event &&
      typeof event.runId === 'string',
  );
  if (!started)
    throw new Error('SDK event sequence must start with RUN_STARTED');
  await lastValueFrom(
    defaultApplyEvents(
      runInput(started.runId),
      from(events),
      harness.agent as unknown as Parameters<typeof defaultApplyEvents>[2],
      [...harness.agentSubscribers] as AgentSubscriber[],
    ).pipe(toArray()),
  );
}

let root: ReactTestRenderer;
const props: Parameters<typeof Chat>[0] = {
  thread: {
    id: 'thread',
    dotId: 'dot',
    ownerId: 'owner',
    title: 'Thread',
    createdAt: 0,
  },
  dot: {
    id: 'dot',
    spaceId: 'space',
    spaceIds: ['space'],
    name: 'Dot',
    instructions: '',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 0,
  },
  onConsumed: vi.fn(),
  voiceReady: false,
  calls: [],
  paused: false,
  onSaved: vi.fn(),
  onSchedule: vi.fn(),
};

async function mountChat() {
  await act(async () => {
    root = create(createElement(Chat, props));
  });
}

function alertText(): string[] {
  return root.root
    .findAll((node) => node.props.role === 'alert')
    .map((node) => String(node.children[0]));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.api.mockClear();
  harness.agent.subscribe.mockClear();
  harness.copilotkit.subscribe.mockClear();
  harness.copilotkit.connectAgent.mockClear();
  harness.api.mockImplementation(async () => null);
  harness.useAgent.mockReturnValue({ agent: harness.agent, isReady: true });
  harness.useCopilotKit.mockReturnValue({ copilotkit: harness.copilotkit });
  vi.stubGlobal('window', { prompt: vi.fn(() => 'Saved conversation') });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('clears a historical run error when replay later finishes successfully', async () => {
  const { agent, copilotkit } = useReplayAgent(
    runError('old-failed', 'Old run failed'),
  );
  const connect = vi.spyOn(copilotkit, 'connectAgent');
  const forwardedError = vi.fn();
  copilotkit.subscribe({ onError: forwardedError });
  await mountChat();
  expect(alertText()).toContain('Old run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();
  expect(forwardedError).toHaveBeenCalledWith(
    expect.objectContaining({
      code: CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT,
    }),
  );

  agent.events = [
    ...runError('replayed-failure', 'Old run failed'),
    ...runFinished('background-success'),
  ];
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(forwardedError).toHaveBeenCalledTimes(2);
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
});

it('keeps a latest historical failure visible without a later success', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('latest-failed', 'Latest run failed'));
  });
  expect(alertText()).toContain('Latest run failed');
});

it('preserves a page-save failure when a background run finishes successfully', async () => {
  harness.api.mockImplementationOnce(async () => null);
  harness.api.mockRejectedValueOnce(new Error('Could not save this page'));
  await mountChat();

  await act(async () => {
    await root.root
      .findByProps({ 'aria-label': 'Save conversation as page' })
      .props.onClick();
  });
  expect(alertText()).toContain('Could not save this page');
  expect(harness.api).toHaveBeenCalledWith(
    '/conversations/thread/page',
    'POST',
    {
      title: 'Saved conversation',
    },
  );

  await act(async () => {
    await applySdkEvents(runFinished('scheduled-success'));
  });
  expect(alertText()).toContain('Could not save this page');
});

it('preserves a page-save failure while a failed run later recovers', async () => {
  await mountChat();
  harness.api.mockRejectedValueOnce(new Error('Could not save this page'));
  await act(async () => {
    await root.root
      .findByProps({ 'aria-label': 'Save conversation as page' })
      .props.onClick();
    await applySdkEvents(runError('prior-failed', 'Old run failed'));
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toContain('Could not save this page');
});

it('preserves an unrelated CopilotKit connection error after a successful run', async () => {
  await mountChat();
  await act(async () => {
    harness.copilotkit.emitError(
      'Connection failed',
      CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
    );
    await applySdkEvents(runFinished('background-success'));
  });
  expect(alertText()).toContain('Connection failed');
});

it('clears a run transport failure forwarded through CopilotKit after recovery', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  const forwardedError = vi.fn();
  copilotkit.subscribe({ onError: forwardedError });
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Run transport failed')),
  );
  await act(async () => {
    await copilotkit.runAgent({ agent });
  });
  expect(alertText()).toContain('Run transport failed');
  expect(forwardedError.mock.calls.map(([event]) => event.code)).toEqual([
    CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT,
    CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
  ]);
  agent.events = runFinished('recovered-success');
  await act(async () => {
    await copilotkit.connectAgent({ agent });
  });
  expect(alertText()).toHaveLength(0);
});

it('clears a failed current turn after a later successful run', async () => {
  await mountChat();
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Message your Dot' }).props.onChange({
      target: { value: 'Hello' },
    });
  });
  await act(async () => {
    root.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
  });
  expect(alertText()).toContain(
    'The current turn returned no response. Check the runtime connection and retry.',
  );
  expect(
    root.root.findAllByProps({ 'aria-label': 'Stop response' }),
  ).toHaveLength(0);
  await act(async () => {
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toHaveLength(0);
});

it('shows a new failure after a successful run clears the previous error', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('prior-failed', 'Old run failed'));
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
  await act(async () => {
    await applySdkEvents(runError('new-failed', 'New run failed'));
  });
  expect(alertText()).toContain('New run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();
});

it('does not treat an interrupted run as a successful recovery', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('previous-failed', 'Previous run failed'));
    await applySdkEvents(runFinished('interrupted-retry', 'interrupt'));
  });
  expect(alertText()).toContain('Previous run failed');
});
