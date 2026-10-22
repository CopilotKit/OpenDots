import type { Message } from '@ag-ui/core';

function reportedError(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    const value = JSON.parse(content);
    if (typeof value?.error === 'string') return value.error;
    if (value?.isError === true) return 'Tool reported an error.';
  } catch {
    if (/^(Error:|Error executing tool|ToolError:)/.test(content))
      return content;
  }
  return undefined;
}

/** Report execution receipts without inferring completion from model prose. */
export function executionReceipt(messages: Message[]): string {
  const issued = new Map(
    messages.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls ?? []).map(
            (call) => [call.id, call.function.name] as const,
          )
        : [],
    ),
  );
  if (!issued.size)
    return 'Chat turn ended: no tools were called. No tool execution was recorded.';
  const returned = new Set<string>();
  const errors = new Map<string, string>();
  const teaching: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || !issued.has(message.toolCallId)) continue;
    returned.add(message.toolCallId);
    const error = reportedError(message.content);
    const toolName = issued.get(message.toolCallId) ?? '';
    if (
      /browser_teach_(start|finish|status|cancel)$|browser_map_(propose|finish)$|browser_targets$/.test(
        toolName,
      )
    ) {
      try {
        const data = JSON.parse(message.content as string);
        if (error)
          teaching.push('Mapping operation failed; no new save verified.');
        else if (
          toolName.endsWith('browser_map_finish') &&
          Array.isArray(data.saved)
        )
          teaching.push(
            `SAVED: ${data.saved.map((target: { name: string }) => target.name).join(', ') || 'none'}. Rejected: ${Array.isArray(data.rejected) ? data.rejected.join(', ') || 'none' : 'unknown'}.`,
          );
        else if (
          toolName.endsWith('browser_teach_finish') &&
          data.id &&
          data.name
        )
          teaching.push(`SAVED: ${data.name} (ID ${data.id}).`);
        else if (
          toolName.endsWith('browser_targets') &&
          Array.isArray(data.targets)
        )
          teaching.push(
            `Saved mappings at lookup: ${
              data.targets
                .filter(
                  (target: { status?: string }) =>
                    target.status !== 'needs_reteach',
                )
                .map((target: { name: string }) => target.name)
                .join(', ') || 'none'
            }.`,
          );
        else if (data.status)
          teaching.push(
            `Teaching ${data.name ?? ''}: ${data.status}${data.status === 'saved' ? '' : ' — no new save verified'}.`,
          );
      } catch {
        /* Malformed results do not establish teaching progress. */
      }
    }
    if (error)
      errors.set(
        message.toolCallId,
        `${issued.get(message.toolCallId)}: ${error.slice(0, 350)}`,
      );
  }
  const missing = issued.size - returned.size;
  return `${teaching.length ? `Mapping receipts: ${teaching.slice(-5).join(' ')}\n\n` : ''}Chat turn ended: ${issued.size} tools called, ${returned.size} results returned, ${errors.size} reported tool errors${missing ? `, ${missing} missing results` : ''}. This does not establish that the task is complete.${errors.size ? ` Errors: ${[...errors.values()].slice(0, 3).join(' | ')}` : ''} Further chat actions require another turn; separately scheduled work appears in Team.`;
}
