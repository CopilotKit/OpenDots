import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from '@copilotkit/runtime/v2';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { chat } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

vi.mock('@tanstack/ai', { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('TanStack AI streams with the verified skill catalog and authorized server tools', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
    workspace.bindThread('thread', dot.id, 'Learning');
    const bytes = readFileSync(
      new URL('./fixtures/learning-skills.zip', import.meta.url),
    );
    vi.spyOn(
      CopilotKitIntelligence.prototype,
      'getLearnedSkillsSnapshots',
    ).mockResolvedValue([
      {
        containerId: 'research',
        status: 'snapshot',
        bytes,
        revision: 'fixture-v1',
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        contentType: 'application/zip',
      },
    ]);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'load-skill',
                type: 'function',
                function: {
                  name: 'copilotkit_load_skill',
                  arguments: JSON.stringify({
                    skill_name: 'research/evidence-review',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Ready to review evidence.' }),
      );
    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'fixture',
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'thread',
          runId: 'run',
          messages: [
            { id: 'message', role: 'user', content: 'Review the evidence.' },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(JSON.stringify(events)).toContain('Ready to review evidence.');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'load-skill',
          content: expect.stringContaining('evidence-review'),
        }),
      ]),
    );
    const request = String(network.mock.calls[0][1]?.body);
    expect(request).toContain('evidence-review');
    expect(request).toContain('copilotkit_load_skill');
    expect(request).toContain('copilotkit_read_skill_file');
    expect(request).toContain('read_space_page');
    expect(request).toContain(
      'Use only the tools provided in this conversation',
    );
  } finally {
    workspace.close();
    store.close();
  }
});

it('native skill delivery fails the invocation before contacting the model when delivery is denied', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
    workspace.bindThread('thread', dot.id, 'Learning');
    const delivery = vi
      .spyOn(CopilotKitIntelligence.prototype, 'getLearnedSkillsSnapshots')
      .mockRejectedValue(new LearnedSkillsError('DELIVERY_DISABLED', false));
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network request'));
    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'fixture',
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    await expect(
      lastValueFrom(agent.run(input).pipe(toArray())),
    ).rejects.toMatchObject({ code: 'DELIVERY_DISABLED' });
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ containers: [{ containerId: 'research' }] }),
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    workspace.close();
    store.close();
  }
});
