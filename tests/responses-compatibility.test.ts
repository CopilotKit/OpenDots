import { afterEach, expect, it, vi } from 'vitest';
import {
  EventType,
  type ReasoningMessage,
  type RunAgentInput,
} from '@ag-ui/core';
import { BuiltInAgent, convertInputToTanStackAI } from '@copilotkit/runtime/v2';
import { chat, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { lastValueFrom, toArray } from 'rxjs';
import { pageReviewTool } from '../src/shared/page-review.js';
import { responses } from './fixtures/responses-stream.js';

afterEach(() => vi.restoreAllMocks());

const signature = JSON.stringify({
  id: 'rs_fixture',
  encrypted_content: 'fixture-encrypted-reasoning',
});
const reviewArguments = {
  title: 'Notes',
  content: '# Review me',
  spaceId: 'space',
};

function input(): RunAgentInput {
  return {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [
      { id: 'user', role: 'user', content: 'Review a page called Notes.' },
    ],
    tools: [pageReviewTool],
    forwardedProps: {},
  };
}

it.each([
  { delivery: 'early', lateEncrypted: false },
  { delivery: 'lateEncrypted', lateEncrypted: true },
])(
  'preserves $delivery encrypted reasoning through BuiltInAgent with correlated message IDs',
  async ({ lateEncrypted }) => {
    // Install before creating the SDK client; unexpected fetches also stay offline.
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected fixture request'))
      .mockResolvedValueOnce(
        responses({
          toolCall: { name: pageReviewTool.name, arguments: reviewArguments },
          lateEncrypted,
        }),
      );
    const chunks: StreamChunk[] = [];
    const agent = new BuiltInAgent({
      type: 'tanstack',
      factory: async function* (ctx) {
        const converted = convertInputToTanStackAI(ctx.input);
        const stream = chat({
          adapter: openaiCompatibleText('custom-model', {
            apiKey: 'fixture',
            baseURL: 'https://unused.invalid/v1',
            api: 'responses',
            maxRetries: 0,
          }),
          messages: converted.messages,
          tools: converted.tools,
          systemPrompts: converted.systemPrompts,
          modelOptions: {
            store: false,
            include: ['reasoning.encrypted_content'],
            max_output_tokens: 2200,
          },
          abortController: ctx.abortController,
          threadId: ctx.input.threadId,
          runId: ctx.input.runId,
        });
        // Observe the real SDK boundary without changing or mocking its chunks.
        for await (const chunk of stream) {
          chunks.push(chunk);
          yield chunk;
        }
      },
    });
    const events = await lastValueFrom(agent.run(input()).pipe(toArray()));
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0][0])).toBe(
      'https://unused.invalid/v1/responses',
    );
    const request = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      model: 'custom-model',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 2200,
      tools: [expect.objectContaining({ name: pageReviewTool.name })],
    });
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    );
    // These guards prove that the fixture reached the real adapter and chat loop.
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'message',
        entityId: expect.any(String),
        encryptedValue: signature,
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_CALL_START,
        toolCallId: 'call_fixture',
        metadata: expect.objectContaining({ itemId: 'fc_fixture' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_CALL_START,
        toolCallId: 'call_fixture',
        toolCallName: pageReviewTool.name,
      }),
    );
    const reasoningStarts = events.filter(
      (event) => event.type === EventType.REASONING_MESSAGE_START,
    );
    expect(reasoningStarts).toHaveLength(1);
    expect(reasoningStarts[0].messageId).toEqual(expect.any(String));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'message',
        entityId: reasoningStarts[0].messageId,
        encryptedValue: signature,
      }),
    );
  },
);

it('preserves serialized reasoning as thinking when converting a declined review continuation', () => {
  const reasoning: ReasoningMessage = {
    id: 'reasoning',
    role: 'reasoning',
    content: '',
    encryptedValue: signature,
  };
  const continuation: RunAgentInput = {
    ...input(),
    messages: [
      ...input().messages,
      reasoning,
      {
        id: 'assistant',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call_fixture',
            type: 'function',
            function: {
              name: pageReviewTool.name,
              arguments: JSON.stringify(reviewArguments),
            },
          },
        ],
      },
      {
        id: 'tool',
        role: 'tool',
        toolCallId: 'call_fixture',
        content: JSON.stringify({ approved: false }),
      },
    ],
  };
  const restored: RunAgentInput = JSON.parse(JSON.stringify(continuation));
  expect(restored.messages).toContainEqual(reasoning);
  const converted = convertInputToTanStackAI(restored);
  expect(converted.systemPrompts.join('\n')).not.toContain(
    'fixture-encrypted-reasoning',
  );
  expect(converted.messages).toContainEqual(
    expect.objectContaining({
      role: 'tool',
      toolCallId: 'call_fixture',
      content: JSON.stringify({ approved: false }),
    }),
  );
  expect(converted.messages).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      toolCalls: expect.arrayContaining([
        expect.objectContaining({
          id: 'call_fixture',
          function: {
            name: pageReviewTool.name,
            arguments: JSON.stringify(reviewArguments),
          },
        }),
      ]),
    }),
  );
  // ModelMessage is the public chat() contract, not the runtime's private layout.
  const messages: ModelMessage[] = converted.messages;
  const thinking = messages.flatMap((message) => message.thinking ?? []);
  expect(thinking).toContainEqual(expect.objectContaining({ signature }));
});
