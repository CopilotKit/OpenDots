/**
 * Gemini 3 compatibility for Google's OpenAI-compatible endpoint.
 *
 * Gemini 3 returns a "thought signature" with each tool call
 * (`tool_calls[].extra_content.google.thought_signature`) and rejects the next
 * request with HTTP 400 ("Function call is missing a thought_signature")
 * unless the signature is sent back on that tool call. The OpenAI-compatible
 * chat adapter does not carry `extra_content`, so every turn that uses a tool
 * fails after the tool runs. This fetch wrapper remembers the signatures it
 * sees in responses and restores them on the matching tool calls of later
 * requests. Tool calls it has never seen (for example history reloaded after a
 * restart) get Google's documented placeholder, which the API accepts.
 *
 * Google requires the original signature unchanged, so a signature is only
 * ever restored on the tool call it came from: the cache is scoped to the
 * caller's conversation/provider, keyed by tool-call ID, and matched on the
 * call's arguments when an ID has been reused.
 */

const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
const MAX_REMEMBERED = 5000;
const MAX_PER_ID = 4;

interface Remembered {
  signature: string;
  args: string;
}

const remembered = new Map<string, Remembered[]>();

export function isGoogleOpenAIEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === GOOGLE_HOST;
  } catch {
    return false;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function signatureOf(call: unknown): string | undefined {
  const signature = field(
    field(field(call, 'extra_content'), 'google'),
    'thought_signature',
  );
  return typeof signature === 'string' && signature ? signature : undefined;
}

function idOf(call: unknown): string | undefined {
  const id = field(call, 'id');
  return typeof id === 'string' && id ? id : undefined;
}

/** Whitespace-insensitive form of a tool call's JSON arguments. */
function normalizeArgs(args: unknown): string {
  if (typeof args !== 'string') return '';
  try {
    return JSON.stringify(JSON.parse(args));
  } catch {
    return args;
  }
}

function cacheKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function remember(
  scope: string,
  id: string,
  signature: string,
  args: string,
): void {
  const key = cacheKey(scope, id);
  const entries = (remembered.get(key) ?? []).filter(
    (entry) => entry.args !== args || entry.signature !== signature,
  );
  entries.push({ signature, args });
  while (entries.length > MAX_PER_ID) entries.shift();
  remembered.delete(key);
  remembered.set(key, entries);
  if (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
}

function recall(scope: string, id: string, args: string): string | undefined {
  const entries = remembered.get(cacheKey(scope, id));
  if (!entries?.length) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1)
    if (entries[i].args === args) return entries[i].signature;
  // The ID was reused with other arguments: only a lone entry is unambiguous.
  return entries.length === 1 ? entries[0].signature : undefined;
}

/** A tool call being assembled from streamed deltas. */
interface Partial {
  id?: string;
  args: string;
  signature?: string;
}

/**
 * Streamed deltas carry the ID, the arguments and the signature in any mix of
 * chunks, so they are assembled per choice and tool-call index first.
 */
function collectDeltas(chunk: unknown, partials: Map<string, Partial>): void {
  const choices = field(chunk, 'choices');
  if (!Array.isArray(choices)) return;
  choices.forEach((choice, choicePosition) => {
    const choiceIndex = field(choice, 'index');
    const calls = field(field(choice, 'delta'), 'tool_calls');
    if (!Array.isArray(calls)) return;
    calls.forEach((call, position) => {
      const index = field(call, 'index');
      const base = `${typeof choiceIndex === 'number' ? choiceIndex : choicePosition}:${
        typeof index === 'number' ? index : position
      }`;
      const id = idOf(call);
      let slot = base;
      let partial = partials.get(slot);
      // Without an index, a different ID means a different tool call.
      if (partial?.id && id && partial.id !== id) {
        slot = `${base}:${id}`;
        partial = partials.get(slot);
      }
      if (!partial) {
        partial = { args: '' };
        partials.set(slot, partial);
      }
      if (id) partial.id = id;
      const args = field(field(call, 'function'), 'arguments');
      if (typeof args === 'string') partial.args += args;
      const signature = signatureOf(call);
      if (signature) partial.signature = signature;
    });
  });
}

function rememberFromMessage(scope: string, body: unknown): void {
  const choices = field(body, 'choices');
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const calls = field(field(choice, 'message'), 'tool_calls');
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const id = idOf(call);
      const signature = signatureOf(call);
      if (id && signature)
        remember(
          scope,
          id,
          signature,
          normalizeArgs(field(field(call, 'function'), 'arguments')),
        );
    }
  }
}

async function rememberFromResponse(
  scope: string,
  response: Response,
): Promise<void> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('event-stream')) {
    const partials = new Map<string, Partial>();
    for (const line of text.split('\n')) {
      const data = line.trim();
      if (!data.startsWith('data:') || data.includes('[DONE]')) continue;
      try {
        collectDeltas(JSON.parse(data.slice(5)), partials);
      } catch {
        // A partial or non-JSON event carries no signature.
      }
    }
    for (const { id, args, signature } of partials.values())
      if (id && signature) remember(scope, id, signature, normalizeArgs(args));
    return;
  }
  try {
    rememberFromMessage(scope, JSON.parse(text));
  } catch {
    // Not a completion body.
  }
}

/** Adds a thought signature to every assistant tool call that lacks one. */
export function restoreThoughtSignatures(body: unknown, scope = ''): number {
  const messages = field(body, 'messages');
  if (!Array.isArray(messages)) return 0;
  let restored = 0;
  for (const message of messages) {
    if (field(message, 'role') !== 'assistant') continue;
    const calls = field(message, 'tool_calls');
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call !== 'object' || call === null || signatureOf(call))
        continue;
      const id = idOf(call);
      const target = call as Record<string, unknown>;
      const extra = field(target, 'extra_content');
      const google = field(extra, 'google');
      target.extra_content = {
        ...(typeof extra === 'object' && extra !== null ? extra : {}),
        google: {
          ...(typeof google === 'object' && google !== null ? google : {}),
          thought_signature:
            (id
              ? recall(
                  scope,
                  id,
                  normalizeArgs(field(field(call, 'function'), 'arguments')),
                )
              : undefined) ?? PLACEHOLDER_SIGNATURE,
        },
      };
      restored += 1;
    }
  }
  return restored;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Wraps fetch for the OpenAI client so Gemini tool-call round trips succeed.
 * `scope` identifies the conversation and provider the requests belong to;
 * signatures are never shared across scopes.
 */
export function geminiToolCallFetch(
  scope: string,
  inner: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    let request = init;
    if (
      typeof init?.body === 'string' &&
      urlOf(input).split('?')[0].endsWith('/chat/completions')
    ) {
      try {
        const body: unknown = JSON.parse(init.body);
        if (restoreThoughtSignatures(body, scope) > 0)
          request = { ...init, body: JSON.stringify(body) };
      } catch {
        // Not JSON: send it unchanged.
      }
    }
    const response = await inner(input, request);
    if (response.ok && response.body)
      void rememberFromResponse(scope, response.clone()).catch(() => undefined);
    return response;
  };
}
