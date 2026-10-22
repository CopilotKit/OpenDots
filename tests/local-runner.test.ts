import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { SqliteAgentRunner } from '../src/server/local-runner.js';

// Emits the start of a reply and then never finishes, like a server that stops.
class StallingAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'a1',
        role: 'assistant',
      } as BaseEvent);
    });
  }
}

it('keeps an interrupted turn and marks it interrupted after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  const path = join(dir, 'db.sqlite');
  try {
    const runner = new SqliteAgentRunner(path);
    const agent = new StallingAgent({ agentId: 'dot' });
    const input: RunAgentInput = {
      threadId: 'thread-crash',
      runId: 'run-1',
      messages: [{ id: 'u1', role: 'user', content: 'Check the chart' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    agent.setMessages(input.messages);
    runner.run({ threadId: input.threadId, agent, input }).subscribe();
    await new Promise((done) => setTimeout(done, 50));
    // Simulate a restart: forget in-memory state, rehydrate from SQLite.
    runner.clearThreads();
    runner.close();
    const restarted = new SqliteAgentRunner(path);
    expect(restarted.getThreadMessages('thread-crash')).toEqual([
      expect.objectContaining({ id: 'u1', content: 'Check the chart' }),
    ]);
    const events = restarted.getThreadEvents('thread-crash');
    expect(events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      message: expect.stringContaining('interrupted'),
    });
    agent.abortRun();
    restarted.clearThreads();
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('deleting a conversation stops its running reply and removes its history for good', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  const path = join(dir, 'db.sqlite');
  try {
    const runner = new SqliteAgentRunner(path);
    const agent = new StallingAgent({ agentId: 'dot' });
    const input: RunAgentInput = {
      threadId: 'thread-delete',
      runId: 'run-1',
      messages: [{ id: 'u1', role: 'user', content: 'Trade until 1k' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    agent.setMessages(input.messages);
    runner.run({ threadId: input.threadId, agent, input }).subscribe({
      error: () => undefined,
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(await runner.isRunning({ threadId: 'thread-delete' })).toBe(true);
    await runner.stop({ threadId: 'thread-delete' });
    await new Promise((done) => setTimeout(done, 50));
    runner.forget('thread-delete');
    expect(await runner.isRunning({ threadId: 'thread-delete' })).toBe(false);
    expect(runner.getThreadMessages('thread-delete')).toEqual([]);
    runner.close();
    // Nothing comes back after a restart.
    const restarted = new SqliteAgentRunner(path);
    expect(restarted.getThreadMessages('thread-delete')).toEqual([]);
    restarted.clearThreads();
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
