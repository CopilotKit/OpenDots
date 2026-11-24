import { expect, it, vi } from 'vitest';
import {
  geminiToolCallFetch,
  isGoogleOpenAIEndpoint,
  restoreThoughtSignatures,
} from '../src/server/gemini-compat.js';

const PLACEHOLDER = 'skip_thought_signature_validator';
const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

function sse(deltas: unknown[]) {
  const text =
    deltas
      .map(
        (delta) =>
          `data: ${JSON.stringify({
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gemini-3',
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n';
  return new Response(text, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function toolCall(id: string, signature: string, args = '{}') {
  return {
    id,
    type: 'function',
    function: { name: 'lookup', arguments: args },
    extra_content: { google: { thought_signature: signature } },
  };
}

function history(id: string, args = '{}') {
  return {
    model: 'gemini-3',
    messages: [
      { role: 'user', content: 'Look it up.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'lookup', arguments: args },
          },
        ],
      },
      { role: 'tool', tool_call_id: id, content: '{}' },
    ],
  };
}

function signatureSent(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body));
  return body.messages[1].tool_calls[0].extra_content?.google
    ?.thought_signature;
}

/** Passes a model response through the wrapper, as the OpenAI client would. */
async function receive(scope: string, response: Response) {
  const wrapped = geminiToolCallFetch(scope, async () => response);
  const result = await wrapped(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ model: 'gemini-3', messages: [] }),
  });
  return result.text();
}

/** The signature the wrapper sends for a replayed tool call. */
async function replay(scope: string, body: unknown) {
  const inner = vi.fn<typeof fetch>().mockImplementation(async () => {
    return new Response('{}');
  });
  await geminiToolCallFetch(scope, inner)(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return signatureSent(inner.mock.calls[0][1]);
}

/** The response is scanned in the background, so wait for it to be learned. */
function eventually(scope: string, body: unknown, expected: string) {
  return vi.waitFor(async () => {
    expect(await replay(scope, body)).toBe(expected);
  });
}

it('recognizes only Google endpoints', () => {
  expect(
    isGoogleOpenAIEndpoint(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
  ).toBe(true);
  expect(isGoogleOpenAIEndpoint('https://api.openai.com/v1')).toBe(false);
  expect(
    isGoogleOpenAIEndpoint(
      'https://generativelanguage.googleapis.com.evil.test/v1',
    ),
  ).toBe(false);
  expect(isGoogleOpenAIEndpoint('not a url')).toBe(false);
  expect(isGoogleOpenAIEndpoint(undefined)).toBe(false);
});

it('sends back the signature Gemini returned, and leaves the response readable', async () => {
  const text = await receive(
    'round-trip',
    sse([
      { role: 'assistant', tool_calls: [toolCall('call-real', 'SIG-REAL')] },
    ]),
  );
  expect(text).toContain('SIG-REAL');
  await eventually('round-trip', history('call-real'), 'SIG-REAL');
});

it('uses the documented placeholder for tool calls it has not seen', async () => {
  expect(await replay('unseen', history('call-from-before-restart'))).toBe(
    PLACEHOLDER,
  );
});

it('keeps a signature that is already present', () => {
  const body = history('call-own');
  Object.assign(body.messages[1].tool_calls![0], {
    extra_content: { google: { thought_signature: 'MINE' } },
  });
  expect(restoreThoughtSignatures(body)).toBe(0);
  expect(JSON.stringify(body)).toContain('MINE');
  expect(JSON.stringify(body)).not.toContain(PLACEHOLDER);
});

it('does not share signatures between conversations that reuse a tool-call ID', async () => {
  await receive(
    'conversation-a',
    sse([{ tool_calls: [toolCall('call_0', 'SIG-A')] }]),
  );
  await receive(
    'conversation-b',
    sse([{ tool_calls: [toolCall('call_0', 'SIG-B')] }]),
  );
  await eventually('conversation-a', history('call_0'), 'SIG-A');
  await eventually('conversation-b', history('call_0'), 'SIG-B');
  // A conversation that never saw the call gets the placeholder, not a stranger's.
  expect(await replay('conversation-c', history('call_0'))).toBe(PLACEHOLDER);
});

it('keeps the original signature when an ID is reused with other arguments', async () => {
  await receive(
    'reused-id',
    sse([{ tool_calls: [toolCall('call_0', 'SIG-1', '{"q":1}')] }]),
  );
  await receive(
    'reused-id',
    sse([{ tool_calls: [toolCall('call_0', 'SIG-2', '{"q":2}')] }]),
  );
  await eventually('reused-id', history('call_0', '{"q":1}'), 'SIG-1');
  await eventually('reused-id', history('call_0', '{"q": 2}'), 'SIG-2');
  // Ambiguous: two calls share the ID and neither matches, so do not guess.
  expect(await replay('reused-id', history('call_0', '{"q":3}'))).toBe(
    PLACEHOLDER,
  );
});

it('assembles fragmented stream deltas before associating the signature', async () => {
  await receive(
    'fragmented',
    sse([
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-frag',
            type: 'function',
            function: { name: 'lookup', arguments: '' },
          },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
      {
        tool_calls: [
          {
            index: 0,
            function: { arguments: '1}' },
            extra_content: { google: { thought_signature: 'SIG-FRAG' } },
          },
        ],
      },
    ]),
  );
  await eventually('fragmented', history('call-frag', '{"q":1}'), 'SIG-FRAG');
});

it('keeps parallel streamed tool calls apart by index', async () => {
  await receive(
    'parallel',
    sse([
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-a',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
          {
            index: 1,
            id: 'call-b',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 1,
            extra_content: { google: { thought_signature: 'SIG-B' } },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            extra_content: { google: { thought_signature: 'SIG-A' } },
          },
        ],
      },
    ]),
  );
  await eventually('parallel', history('call-a'), 'SIG-A');
  await eventually('parallel', history('call-b'), 'SIG-B');
});

it('reads signatures from a non-streaming completion', async () => {
  await receive(
    'json',
    new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [toolCall('call-json', 'SIG-JSON')],
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  await eventually('json', history('call-json'), 'SIG-JSON');
});

it('does not touch other requests or non-JSON bodies', async () => {
  const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const wrapped = geminiToolCallFetch('untouched', inner);
  const other = JSON.stringify(history('call-other'));
  await wrapped(
    'https://generativelanguage.googleapis.com/v1beta/openai/models',
    {
      method: 'POST',
      body: other,
    },
  );
  await wrapped(ENDPOINT, { method: 'POST', body: 'not json' });
  await wrapped(ENDPOINT, { method: 'GET' });
  expect(inner.mock.calls[0][1]?.body).toBe(other);
  expect(inner.mock.calls[1][1]?.body).toBe('not json');
  expect(inner.mock.calls[2][1]?.body).toBeUndefined();
});

it('tells unindexed streamed tool calls apart by their IDs', async () => {
  await receive(
    'unindexed',
    sse([
      {
        tool_calls: [
          {
            id: 'call-x',
            function: { name: 'lookup', arguments: '{"n":1}' },
            extra_content: { google: { thought_signature: 'SIG-X' } },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 'call-y',
            function: { name: 'lookup', arguments: '{"n":2}' },
            extra_content: { google: { thought_signature: 'SIG-Y' } },
          },
        ],
      },
    ]),
  );
  await eventually('unindexed', history('call-x', '{"n":1}'), 'SIG-X');
  await eventually('unindexed', history('call-y', '{"n":2}'), 'SIG-Y');
});

it('keeps tool calls from different choices apart', async () => {
  const chunk = (choice: number, call: Record<string, unknown>) => ({
    choices: [
      { index: choice, delta: { tool_calls: [{ index: 0, ...call }] } },
    ],
  });
  const signed = (signature: string) => ({
    extra_content: { google: { thought_signature: signature } },
  });
  const events = [
    chunk(0, { id: 'call-choice-0', function: { name: 'lookup' } }),
    chunk(1, { id: 'call-choice-1', function: { name: 'lookup' } }),
    chunk(0, signed('SIG-C0')),
    chunk(1, signed('SIG-C1')),
  ];
  await receive(
    'choices',
    new Response(
      events.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  await eventually('choices', history('call-choice-0'), 'SIG-C0');
  await eventually('choices', history('call-choice-1'), 'SIG-C1');
});

it('keeps learning after a malformed event in the stream', async () => {
  const good = `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [toolCall('call-after', 'SIG-AFTER')] },
      },
    ],
  })}\n\n`;
  await receive(
    'malformed',
    new Response(`data: {not json\n\n${good}data: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  await eventually('malformed', history('call-after'), 'SIG-AFTER');
});

it('does not remember anything from a failed response', async () => {
  const failed = new Response(
    JSON.stringify({
      choices: [
        { message: { tool_calls: [toolCall('call-failed', 'SIG-BAD')] } },
      ],
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
  await receive('failed', failed);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await replay('failed', history('call-failed'))).toBe(PLACEHOLDER);
});

it('forgets the oldest argument variants when one ID is reused many times', async () => {
  for (let n = 1; n <= 5; n += 1)
    await receive(
      'many-reuses',
      sse([{ tool_calls: [toolCall('call_0', `SIG-${n}`, `{"n":${n}}`)] }]),
    );
  await eventually('many-reuses', history('call_0', '{"n":5}'), 'SIG-5');
  await eventually('many-reuses', history('call_0', '{"n":2}'), 'SIG-2');
  // Only the four most recent are kept; the evicted one falls back safely.
  expect(await replay('many-reuses', history('call_0', '{"n":1}'))).toBe(
    PLACEHOLDER,
  );
});

it('bounds memory by dropping the oldest tool calls', async () => {
  const total = 5100;
  for (let n = 0; n < total; n += 1)
    await receive(
      `bounded-${n}`,
      sse([{ tool_calls: [toolCall('call_0', `SIG-${n}`)] }]),
    );
  await eventually(
    `bounded-${total - 1}`,
    history('call_0'),
    `SIG-${total - 1}`,
  );
  expect(await replay('bounded-0', history('call_0'))).toBe(PLACEHOLDER);
});

it('uses the placeholder for a tool call without an ID', async () => {
  const body = history('x');
  delete (body.messages[1].tool_calls![0] as { id?: string }).id;
  expect(await replay('no-id', body)).toBe(PLACEHOLDER);
});

it('keeps other extra_content fields when adding the signature', () => {
  const body = history('call-extra');
  Object.assign(body.messages[1].tool_calls![0], {
    extra_content: { google: { other: 1 }, vendor: { keep: true } },
  });
  expect(restoreThoughtSignatures(body)).toBe(1);
  const call = body.messages[1].tool_calls![0] as unknown as {
    extra_content: Record<string, Record<string, unknown>>;
  };
  expect(call.extra_content.google).toEqual({
    other: 1,
    thought_signature: PLACEHOLDER,
  });
  expect(call.extra_content.vendor).toEqual({ keep: true });
});

it('restores signatures when fetch is called with a URL object and a query string', async () => {
  const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  await geminiToolCallFetch('url-object', inner)(
    new URL(`${ENDPOINT}?alt=json`),
    { method: 'POST', body: JSON.stringify(history('call-url')) },
  );
  expect(signatureSent(inner.mock.calls[0][1])).toBe(PLACEHOLDER);
});
