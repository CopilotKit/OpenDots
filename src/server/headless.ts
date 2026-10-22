import type { AbstractAgent } from '@ag-ui/client';
import { EventType, type Message, type RunAgentInput } from '@ag-ui/core';
import type { InMemoryAgentRunner } from '@copilotkit/runtime/v2';
import { randomUUID } from 'node:crypto';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

// Server-side turn (scheduled tasks, voice compute) run in-process through the
// same local runner the chat UI uses, so the turn lands in the same thread.
export async function runLocalTurn(
  runner: InMemoryAgentRunner,
  agent: AbstractAgent,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
  onCompleted?: (messages: Message[]) => void,
): Promise<string> {
  signal.throwIfAborted();
  const history = runner.getThreadMessages(threadId);
  const message = {
    id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  } as Message;
  const messages = [...history, message];
  agent.threadId = threadId;
  agent.setMessages(messages);
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  const known = new Set(messages.map((item) => item.id));
  return new Promise<string>((resolve, reject) => {
    let runError: Error | undefined;
    const stop = () => void runner.stop({ threadId, runId: input.runId });
    signal.addEventListener('abort', stop, { once: true });
    const finish = () => {
      signal.removeEventListener('abort', stop);
      try {
        signal.throwIfAborted();
        onCompleted?.(agent.messages.filter((item) => !known.has(item.id)));
        resolve(
          currentTurnText(
            agent.messages.filter((item) => !known.has(item.id)),
            runError,
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    runner.run({ threadId, agent, input }).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_ERROR)
          runError = new Error((event as { message?: string }).message);
      },
      complete: finish,
      error: (error: unknown) => {
        runError = error instanceof Error ? error : new Error(String(error));
        finish();
      },
    });
  });
}
