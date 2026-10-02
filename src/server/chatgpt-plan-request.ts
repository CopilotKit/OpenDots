const unsupported = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

export function chatgptPlanErrorMessage(code?: string) {
  return code === 'subscription_sharing_usage_limit_exceeded'
    ? 'Your ChatGPT plan usage limit was reached. Try again later or explicitly switch providers in Settings.'
    : code === 'subscription_sharing_usage_unavailable'
      ? 'ChatGPT plan usage is temporarily unavailable. Try again later or explicitly switch providers in Settings.'
      : code === 'subscription_sharing_user_not_eligible'
        ? 'This ChatGPT account or workspace is not eligible for plan usage. Explicitly switch providers in Settings if you want to use API billing.'
        : 'ChatGPT could not complete this request. Reconnect ChatGPT or explicitly switch providers in Settings.';
}

function sanitizePlanErrorStream(response: Response) {
  if (!response.headers.get('content-type')?.includes('text/event-stream'))
    return response;
  const reader = response.body?.getReader();
  if (!reader) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const transform = (line: string) => {
    if (!line.startsWith('data: ')) return line;
    try {
      const event = JSON.parse(line.slice(6)) as {
        type?: string;
        response?: { error?: { code?: string; message?: string } };
      };
      if (event.type !== 'response.failed' || !event.response?.error)
        return line;
      event.response.error.message = chatgptPlanErrorMessage(
        event.response.error.code,
      );
      return `data: ${JSON.stringify(event)}`;
    } catch {
      return line;
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer) controller.enqueue(encoder.encode(transform(buffer)));
          controller.close();
          return;
        }
        const lines = (
          buffer + decoder.decode(chunk.value, { stream: true })
        ).split('\n');
        buffer = lines.pop() ?? '';
        const output = `${lines.map(transform).join('\n')}\n`;
        if (output) {
          controller.enqueue(encoder.encode(output));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Enforce the current ChatGPT plan Responses subset while keeping TanStack's local function tools. */
export function chatgptPlanBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of unsupported) delete next[key];
  if (Array.isArray(next.tools) && next.tools.length) {
    const tools = next.tools;
    delete next.tools;
    const input = Array.isArray(next.input) ? [...next.input] : [];
    const existing = input.findIndex(
      (item) =>
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'additional_tools',
    );
    if (existing >= 0) input.splice(existing, 1);
    // The same tool set must be visible before replayed history/tool calls on every continuation.
    input.unshift({ type: 'additional_tools', role: 'developer', tools });
    next.input = input;
  }
  return next;
}

export const chatgptPlanFetch: typeof fetch = async (input, init) => {
  const request =
    input instanceof Request ? input.clone() : new Request(input, init);
  if (request.method === 'GET' || request.method === 'HEAD')
    return fetch(request);
  const raw =
    typeof init?.body === 'string' ? init.body : await request.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fetch(request);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return fetch(request);
  return fetch(
    new Request(request, {
      body: JSON.stringify(chatgptPlanBody(body as Record<string, unknown>)),
    }),
  );
};

export function createChatgptPlanFetch(
  getValidAccessToken: () => Promise<string>,
): typeof fetch {
  return async (input, init) => {
    const request =
      input instanceof Request ? input.clone() : new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${await getValidAccessToken()}`);
    const response = await chatgptPlanFetch(new Request(request, { headers }));
    return sanitizePlanErrorStream(response);
  };
}
