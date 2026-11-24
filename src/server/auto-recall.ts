import type { Message } from '@ag-ui/core';
import type { ConnectionActionResult } from '../shared/connection-types.js';
import type { ExposedTool } from './connections.js';

export interface RecallSource {
  tools(dotId: string): ExposedTool[];
  call(
    exposed: ExposedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult>;
}

interface Recalled {
  name: string;
  query: string;
  text: string;
}

const QUERY_LIMIT = 500;
const RESULT_LIMIT = 4_000;
// A voice turn cannot wait long; a slow memory server must not stall the answer.
const RECALL_TIMEOUT_MS = 4_000;

function lastUserText(messages: { role: string; content?: unknown }[]) {
  const message = messages.findLast((item) => item.role === 'user');
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join(' ');
  return '';
}

/**
 * Looks up the Dot's memory before the model runs, so answering from memory
 * does not depend on the model deciding to call recall. Uses the Dot's own
 * connected `recall` tool, and only when the server marks it read-only and the
 * owner has not put it behind approval. Any failure returns null: the turn
 * goes on without memory rather than failing.
 */
export async function autoRecall(
  source: RecallSource,
  dotId: string,
  messages: { role: string; content?: unknown }[],
  signal: AbortSignal,
): Promise<Recalled | null> {
  const query = lastUserText(messages).trim().slice(0, QUERY_LIMIT);
  if (query.length < 3) return null;
  const recall = source
    .tools(dotId)
    .find(
      ({ tool }) =>
        tool.name === 'recall' && tool.readOnly && !tool.requiresApproval,
    );
  if (!recall) return null;
  try {
    const result = await source.call(
      recall,
      { query },
      AbortSignal.any([signal, AbortSignal.timeout(RECALL_TIMEOUT_MS)]),
    );
    const text = result.text.trim();
    if (result.isError || !text) return null;
    return { name: recall.name, query, text: text.slice(0, RESULT_LIMIT) };
  } catch {
    return null;
  }
}

// A tool result, not user text: the memory server's output is untrusted.
export function withRecall(
  messages: Message[],
  recalled: Recalled | null,
): Message[] {
  if (!recalled) return messages;
  const index = messages.findLastIndex((message) => message.role === 'user');
  if (index === -1) return messages;
  return messages.toSpliced(
    index + 1,
    0,
    {
      id: 'auto-recall-call',
      role: 'assistant',
      toolCalls: [
        {
          id: 'auto-recall',
          type: 'function',
          function: {
            name: recalled.name,
            arguments: JSON.stringify({ query: recalled.query }),
          },
        },
      ],
    },
    {
      id: 'auto-recall-result',
      role: 'tool',
      toolCallId: 'auto-recall',
      content: recalled.text,
    },
  );
}
