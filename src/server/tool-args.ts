import type { Message } from '@ag-ui/core';

/**
 * Returns the first complete JSON value in text, or undefined. Some local
 * models stream tool arguments twice ('{"a":1}{"a":1}'), which is not valid
 * JSON and makes the model server reject the whole conversation afterwards.
 */
export function firstJson(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Makes every assistant tool call carry valid JSON arguments. */
export function repairToolArguments(messages: Message[]): Message[] {
  return messages.map((message) => {
    const calls = (
      message as { toolCalls?: { function: { arguments: string } }[] }
    ).toolCalls;
    if (message.role !== 'assistant' || !calls?.length) return message;
    let changed = false;
    const toolCalls = calls.map((call) => {
      const raw = call.function.arguments ?? '';
      try {
        JSON.parse(raw || '{}');
        if (raw) return call;
      } catch {
        // fall through to repair
      }
      changed = true;
      return {
        ...call,
        function: { ...call.function, arguments: firstJson(raw) ?? '{}' },
      };
    });
    return changed ? ({ ...message, toolCalls } as Message) : message;
  });
}

/** Rough characters-per-token for budgeting (English text, JSON, code). */
const charsPerToken = 3.5;

function size(message: Message) {
  return JSON.stringify(message).length;
}

/**
 * Fits the conversation into a character budget so the model always has room
 * to answer: older tool results are shortened first, then the oldest messages
 * are dropped. The latest user message and the most recent turn stay intact,
 * and the kept history never starts with an orphaned tool result.
 */
export function fitHistory(
  messages: Message[],
  maxChars: number,
  keepFull = 6,
): Message[] {
  const shortened = messages.map((message, index) => {
    const recent = index >= messages.length - keepFull;
    if (message.role !== 'tool' || typeof message.content !== 'string')
      return message;
    const limit = recent ? 6000 : 600;
    return message.content.length > limit
      ? ({
          ...message,
          content: `${message.content.slice(0, limit)}\n…[older tool output shortened]`,
        } as Message)
      : message;
  });
  let total = shortened.reduce((sum, m) => sum + size(m), 0);
  let start = 0;
  const lastUser = shortened.map((m) => m.role).lastIndexOf('user');
  while (total > maxChars && start < lastUser)
    total -= size(shortened[start++]);
  // Begin on a user message so tool results never lose their tool call.
  while (start < shortened.length && shortened[start].role !== 'user') start++;
  return start >= shortened.length
    ? shortened.slice(lastUser)
    : shortened.slice(start);
}

/** History budget in characters for a model context of `contextTokens`. */
export function historyBudget(contextTokens: number, reservedTokens: number) {
  return Math.max(
    4000,
    Math.floor((contextTokens - reservedTokens) * charsPerToken),
  );
}
