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

/** Enforce the current ChatGPT plan Responses subset while keeping TanStack's local function tools. */
export function chatgptPlanBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of unsupported) delete next[key];
  if (Array.isArray(next.tools) && next.tools.length) {
    const tools = next.tools;
    delete next.tools;
    const input = Array.isArray(next.input) ? [...next.input] : [];
    input.push({ type: 'additional_tools', role: 'developer', tools });
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
    return chatgptPlanFetch(new Request(request, { headers }));
  };
}
