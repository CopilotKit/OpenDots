import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
    onError?: (params: { error: Error }) => void;
  };
  const agentSubscribers: Subscriber[] = [];
  const copilotSubscribers: Subscriber[] = [];
  const agent = {
    messages: [],
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
    emitRunError(message: string) {
      const params = { event: { type: 'RUN_ERROR', message } };
      for (const subscriber of [...agentSubscribers])
        subscriber.onRunErrorEvent?.(params);
    },
    emitRunFinished(outcome: 'success' | 'interrupt') {
      const params = {
        event: { type: 'RUN_FINISHED' },
        outcome,
        ...(outcome === 'interrupt' ? { interrupts: [] } : {}),
      };
      for (const subscriber of [...agentSubscribers])
        subscriber.onRunFinishedEvent?.(params);
    },
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
    emitError(message: string) {
      const params = { error: new Error(message) };
      for (const subscriber of [...copilotSubscribers])
        subscriber.onError?.(params);
    },
  };
  return {
    agent,
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('clears a historical run error when replay later finishes successfully', async () => {
  await mountChat();
  await act(async () => {
    harness.agent.emitRunError('Old run failed');
    harness.copilotkit.emitError('Old run failed');
  });
  expect(alertText()).toContain('Old run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();

  harness.copilotkit.connectAgent.mockImplementationOnce(async () => {
    harness.agent.emitRunError('Old run failed');
    harness.copilotkit.emitError('Old run failed');
    harness.agent.emitRunFinished('success');
    return {};
  });
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  expect(harness.copilotkit.connectAgent).toHaveBeenCalledTimes(2);
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
});

it('keeps a latest historical failure visible without a later success', async () => {
  await mountChat();
  await act(async () => {
    harness.agent.emitRunError('Latest run failed');
    harness.copilotkit.emitError('Latest run failed');
  });
  expect(alertText()).toContain('Latest run failed');
});

it('shows a new failure after a successful run clears the previous error', async () => {
  await mountChat();
  await act(async () => {
    harness.agent.emitRunError('Old run failed');
    harness.agent.emitRunFinished('success');
  });
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
  await act(async () => {
    harness.agent.emitRunError('New run failed');
    harness.copilotkit.emitError('New run failed');
  });
  expect(alertText()).toContain('New run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();
});

it('does not treat an interrupted run as a successful recovery', async () => {
  await mountChat();
  await act(async () => {
    harness.agent.emitRunError('Previous run failed');
    harness.copilotkit.emitError('Previous run failed');
    harness.agent.emitRunFinished('interrupt');
  });
  expect(alertText()).toContain('Previous run failed');
});
