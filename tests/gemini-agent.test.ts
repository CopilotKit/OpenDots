import { afterEach, expect, it, vi } from 'vitest';
import { type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const ARGUMENTS = JSON.stringify({ title: 'Notes', content: '# Notes' });

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

function fixture(baseUrl: string, threadId: string) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread(threadId, dot.id, 'Gemini');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'gemini-3',
      baseUrl,
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId,
    runId: `run-${threadId}`,
    state: {},
    context: [],
    messages: [
      { id: 'user', role: 'user', content: 'Create a page called Notes.' },
    ],
    tools: [],
    forwardedProps: {},
  };
  return { agent, input };
}

function toolCallStream(
  deltas: Array<Record<string, unknown>>,
  finishReason = 'tool_calls',
) {
  const chunks = [
    ...deltas.map((delta) => ({ index: 0, delta, finish_reason: null })),
    { index: 0, delta: {}, finish_reason: finishReason },
  ].map((choice) => ({
    id: 'completion',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gemini-3',
    choices: [choice],
  }));
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function createPage(signature: string) {
  return toolCallStream([
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'create-page',
          type: 'function',
          function: { name: 'create_space_page', arguments: ARGUMENTS },
          extra_content: { google: { thought_signature: signature } },
        },
      ],
    },
  ]);
}

function assistantToolCall(body: unknown) {
  const { messages } = body as {
    messages: Array<{
      role: string;
      tool_calls?: Array<{
        extra_content?: { google?: { thought_signature?: string } };
      }>;
    }>;
  };
  return messages.find(
    (message) => message.role === 'assistant' && message.tool_calls,
  )?.tool_calls?.[0];
}

async function runTurn(
  f: ReturnType<typeof fixture>,
  responses: Response[],
  input: RunAgentInput = f.input,
) {
  const network = vi.spyOn(globalThis, 'fetch');
  for (const response of responses) network.mockResolvedValueOnce(response);
  await lastValueFrom(f.agent.run(input).pipe(toArray()));
  const requests = network.mock.calls.map((call) =>
    JSON.parse(String(call[1]?.body)),
  );
  network.mockRestore();
  return requests;
}

it('sends Gemini thought signatures back when continuing after a tool call', async () => {
  const f = fixture(GOOGLE, 'thread-continue');
  const requests = await runTurn(f, [
    createPage('SIGNATURE-1'),
    completion({ role: 'assistant', content: 'Created Notes.' }),
  ]);
  expect(requests).toHaveLength(2);
  expect(
    assistantToolCall(requests[1])?.extra_content?.google?.thought_signature,
  ).toBe('SIGNATURE-1');
});

it('keeps a signature that arrives in a later stream delta than the tool call ID', async () => {
  const f = fixture(GOOGLE, 'thread-fragmented');
  const requests = await runTurn(f, [
    toolCallStream([
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'create-page',
            type: 'function',
            function: { name: 'create_space_page', arguments: '' },
          },
        ],
      },
      {
        tool_calls: [
          { index: 0, function: { arguments: ARGUMENTS.slice(0, 12) } },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            function: { arguments: ARGUMENTS.slice(12) },
            extra_content: { google: { thought_signature: 'SIGNATURE-LATE' } },
          },
        ],
      },
    ]),
    completion({ role: 'assistant', content: 'Created Notes.' }),
  ]);
  expect(requests).toHaveLength(2);
  expect(
    assistantToolCall(requests[1])?.extra_content?.google?.thought_signature,
  ).toBe('SIGNATURE-LATE');
});

it('does not replay another conversation’s signature for a reused tool-call ID', async () => {
  const history = (base: RunAgentInput): RunAgentInput => ({
    ...base,
    messages: [
      { id: 'user', role: 'user', content: 'Create a page called Notes.' },
      {
        id: 'assistant',
        role: 'assistant',
        toolCalls: [
          {
            id: 'create-page',
            type: 'function',
            function: { name: 'create_space_page', arguments: ARGUMENTS },
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        toolCallId: 'create-page',
        content: '{"ok":true}',
      },
      { id: 'again', role: 'user', content: 'Thanks.' },
    ],
  });
  const reply = () => completion({ role: 'assistant', content: 'Done.' });
  const a = fixture(GOOGLE, 'thread-a');
  const b = fixture(GOOGLE, 'thread-b');
  await runTurn(a, [
    createPage('SIGNATURE-A'),
    completion({ role: 'assistant', content: 'Created.' }),
  ]);
  await runTurn(b, [
    createPage('SIGNATURE-B'),
    completion({ role: 'assistant', content: 'Created.' }),
  ]);
  const signatureFor = async (f: typeof a) => {
    const [request] = await runTurn(f, [reply()], history(f.input));
    return assistantToolCall(request)?.extra_content?.google?.thought_signature;
  };
  await vi.waitFor(async () =>
    expect(await signatureFor(a)).toBe('SIGNATURE-A'),
  );
  await vi.waitFor(async () =>
    expect(await signatureFor(b)).toBe('SIGNATURE-B'),
  );
});

it('does not add Gemini fields for other providers', async () => {
  const f = fixture('https://unused.invalid/v1', 'thread-other');
  const requests = await runTurn(f, [
    toolCallStream([
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'create-page',
            type: 'function',
            function: { name: 'create_space_page', arguments: ARGUMENTS },
          },
        ],
      },
    ]),
    completion({ role: 'assistant', content: 'Created Notes.' }),
  ]);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).not.toContain('thought_signature');
});
