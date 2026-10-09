import type {
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

type ResponsesOptions =
  | {
      toolCall: { name: string; arguments: Record<string, unknown> };
      lateEncrypted?: boolean;
    }
  | { text: string };

function response(
  output: OpenAIResponse['output'],
  status: 'in_progress' | 'completed',
): OpenAIResponse {
  return {
    id: 'resp_fixture',
    access_programs: null,
    object: 'response',
    created_at: 1,
    model: 'custom-model',
    status,
    output,
    output_text: output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
      .join(''),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: false,
    temperature: null,
    top_p: null,
    tool_choice: 'auto',
    tools: [],
    max_output_tokens: 2200,
    ...(status === 'completed' && {
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 30,
      },
    }),
  };
}

export function responsesEvents(
  options: ResponsesOptions,
): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: response([], 'in_progress'),
    },
  ];
  let output: OpenAIResponse['output'];
  if ('toolCall' in options) {
    const reasoning: ResponseReasoningItem = {
      id: 'rs_fixture',
      type: 'reasoning',
      summary: [],
      status: 'completed',
      encrypted_content: 'fixture-encrypted-reasoning',
    };
    // Exercise providers that only deliver the encrypted blob at completion.
    const streamedReasoning = { ...reasoning };
    if (options.lateEncrypted) delete streamedReasoning.encrypted_content;
    const toolCall = {
      id: 'fc_fixture',
      type: 'function_call',
      call_id: 'call_fixture',
      name: options.toolCall.name,
      arguments: JSON.stringify(options.toolCall.arguments),
      status: 'completed',
    } satisfies ResponseFunctionToolCall;
    events.push(
      {
        type: 'response.output_item.added',
        sequence_number: events.length,
        output_index: 0,
        item: { ...streamedReasoning, status: 'in_progress' },
      },
      {
        type: 'response.output_item.done',
        sequence_number: events.length + 1,
        output_index: 0,
        item: streamedReasoning,
      },
      {
        type: 'response.output_item.added',
        sequence_number: events.length + 2,
        output_index: 1,
        item: { ...toolCall, arguments: '', status: 'in_progress' },
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: events.length + 3,
        output_index: 1,
        item_id: toolCall.id,
        delta: toolCall.arguments,
      },
      {
        type: 'response.function_call_arguments.done',
        sequence_number: events.length + 4,
        output_index: 1,
        item_id: toolCall.id,
        arguments: toolCall.arguments,
      },
      {
        type: 'response.output_item.done',
        sequence_number: events.length + 5,
        output_index: 1,
        item: toolCall,
      },
    );
    output = [reasoning, toolCall];
  } else {
    const message: ResponseOutputMessage = {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: options.text, annotations: [] }],
    };
    events.push(
      {
        type: 'response.output_item.added',
        sequence_number: events.length,
        output_index: 0,
        item: { ...message, content: [], status: 'in_progress' },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: events.length + 1,
        output_index: 0,
        content_index: 0,
        item_id: message.id,
        delta: options.text,
        logprobs: [],
      },
      {
        type: 'response.output_text.done',
        sequence_number: events.length + 2,
        output_index: 0,
        content_index: 0,
        item_id: message.id,
        text: options.text,
        logprobs: [],
      },
      {
        type: 'response.output_item.done',
        sequence_number: events.length + 3,
        output_index: 0,
        item: message,
      },
    );
    output = [message];
  }
  events.push({
    type: 'response.completed',
    sequence_number: events.length,
    response: response(output, 'completed'),
  });
  return events;
}

export function responses(options: ResponsesOptions) {
  return streamResponse(responsesEvents(options));
}

export type ResponsesFailure = 'failed' | 'incomplete' | 'truncated';

export function responsesFailure(failure: ResponsesFailure) {
  const events = responsesEvents({ text: 'Partial answer.' });
  const completed = events.pop();
  if (completed?.type !== 'response.completed')
    throw new Error('Expected a completed fixture response');
  if (failure === 'failed') {
    events.push({
      type: 'response.failed',
      sequence_number: events.length,
      response: {
        ...completed.response,
        status: 'failed',
        error: { code: 'server_error', message: 'Fixture provider failed.' },
      },
    });
  } else if (failure === 'incomplete') {
    events.push({
      type: 'response.incomplete',
      sequence_number: events.length,
      response: {
        ...completed.response,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    });
  }
  return streamResponse(events);
}

function streamResponse(events: ResponseStreamEvent[]) {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
