import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const agent = {
    messages: [],
    state: {},
    pendingInterrupts: [],
    addMessage: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };
  const copilotkit = {
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    connectAgent: vi.fn(async () => ({})),
    runAgent: vi.fn(async () => ({ newMessages: [] })),
  };
  return {
    agent,
    copilotkit,
    api: vi.fn(async () => null),
    useAgent: vi.fn(() => ({ agent, isReady: true })),
    useCopilotKit: vi.fn(() => ({ copilotkit })),
    useThreads: vi.fn(() => ({
      threads: [],
      error: undefined,
      hasMoreThreads: false,
      isFetchingMoreThreads: false,
      fetchMoreThreads: vi.fn(),
    })),
  };
});

vi.mock('../src/client/api', () => ({ api: harness.api }));
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: vi.fn(),
  useHumanInTheLoop: vi.fn(),
  useAgent: harness.useAgent,
  useCopilotKit: harness.useCopilotKit,
  useThreads: harness.useThreads,
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
import { ConfirmDeleteModal } from '../src/client/ConfirmDeleteModal';
import { ThreadList } from '../src/client/ThreadList';

const text = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  if (!node || typeof node !== 'object') return '';
  const obj = node as { props?: { children?: unknown }; children?: unknown };
  const child =
    'props' in obj ? (obj.props?.children ?? obj.children) : obj.children;
  return typeof child === 'undefined' ? '' : text(child);
};

let root: ReactTestRenderer;
const chatProps: Parameters<typeof Chat>[0] = {
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
    appsAllowed: false,
    composioToolkits: [],
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
    root = create(createElement(Chat, chatProps));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.api.mockReset();
  harness.useAgent.mockReturnValue({
    agent: harness.agent,
    isReady: true,
  });
  harness.useCopilotKit.mockReturnValue({
    copilotkit: harness.copilotkit,
  });
  vi.stubGlobal('window', { prompt: vi.fn(() => 'Saved conversation') });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Chat thread header deletion button', () => {
  it('shows a delete button for owned conversations and asks the caller to confirm', async () => {
    const onDeleteThread = vi.fn();
    chatProps.onDeleteThread = onDeleteThread;
    await mountChat();
    const button = root.root.findByProps({
      'aria-label': 'Delete conversation',
    });
    expect(button).toBeDefined();
    await act(async () => {
      button.props.onClick();
    });
    expect(onDeleteThread).toHaveBeenCalledTimes(1);
  });

  it('hides the delete button for page conversations that do not pass the callback', async () => {
    delete chatProps.onDeleteThread;
    await mountChat();
    expect(
      root.root.findAllByProps({ 'aria-label': 'Delete conversation' }),
    ).toHaveLength(0);
  });
});

describe('ConfirmDeleteModal', () => {
  async function mountModal({
    busy = false,
    error = '',
  }: {
    busy?: boolean;
    error?: string;
  } = {}) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    await act(async () => {
      root = create(
        createElement(ConfirmDeleteModal, {
          title: 'Old research',
          busy,
          error,
          onCancel,
          onConfirm,
        }),
      );
    });
    return { onCancel, onConfirm };
  }

  it('states the conversation name and the permanent nature of the action', async () => {
    await mountModal();
    expect(text(root.toJSON())).toContain('Delete “Old research”?');
    expect(text(root.toJSON())).toContain('cannot be undone');
  });

  it('copies the decision to Cancel and Delete buttons', async () => {
    const { onCancel, onConfirm } = await mountModal();
    await act(async () => {
      root.root
        .findAll((node) => node.type === 'button')
        .find((button) => text(button.props.children) === 'Cancel')!
        .props.onClick();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => {
      root.root
        .findAll((node) => node.type === 'button')
        .find((button) =>
          text(button.props.children).includes('Delete thread'),
        )!
        .props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both actions and shows the failure while deletion is busy', async () => {
    await mountModal({
      busy: true,
      error: 'Could not delete the conversation.',
    });
    expect(text(root.toJSON())).toContain('Could not delete the conversation.');
    for (const button of root.root.findAll((node) => node.type === 'button')) {
      expect(button.props.disabled).toBe(true);
    }
  });
});

describe('ThreadList removal animation', () => {
  const dots = [
    {
      id: 'dot',
      spaceId: 'space',
      spaceIds: ['space'],
      name: 'Dot',
      instructions: '',
      researchAllowed: false,
      memoryAllowed: false,
      appsAllowed: false,
      composioToolkits: [],
      createdAt: 0,
    },
  ];
  const conversations = [
    {
      id: 'one',
      dotId: 'dot',
      ownerId: 'owner',
      title: 'First',
      createdAt: 1,
    },
    {
      id: 'two',
      dotId: 'dot',
      ownerId: 'owner',
      title: 'Second',
      createdAt: 2,
    },
  ];

  it('lets the removed thread fade out while others stay selectable', async () => {
    await act(async () => {
      root = create(
        createElement(ThreadList, {
          dots,
          dotId: 'dot',
          local: conversations,
          selected: 'one',
          removing: 'one',
          onSelect: vi.fn(),
          onNew: vi.fn(),
        }),
      );
    });
    const items = root.root.findAll(
      (node) =>
        node.type === 'button' && node.props.className?.includes('nav-item'),
    );
    const byTitle = (title: string) =>
      items.find((item) => text(item.props.children).includes(title))!;
    expect(byTitle('First').props.className).toContain('removing');
    expect(byTitle('First').props.disabled).toBe(true);
    expect(byTitle('Second').props.className).not.toContain('removing');
    expect(byTitle('Second').props.disabled).toBeFalsy();
  });
});
