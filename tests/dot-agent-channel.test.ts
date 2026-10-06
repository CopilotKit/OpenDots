import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { SetupTelemetry } from '../src/server/setup-telemetry.js';
import { Subject } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
const inner = vi.hoisted(() => ({
  configure:
    vi.fn<
      (
        options: ConstructorParameters<
          typeof import('@copilotkit/runtime/v2').BuiltInAgent
        >[0],
      ) => void
    >(),
  run: vi.fn<(input: RunAgentInput) => Observable<BaseEvent>>(),
  abortRun: vi.fn(),
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@copilotkit/runtime/v2')>();
  return {
    ...original,
    BuiltInAgent: class {
      constructor(
        options: ConstructorParameters<typeof original.BuiltInAgent>[0],
      ) {
        inner.configure(options);
      }
      run = inner.run;
      abortRun = inner.abortRun;
    },
  };
});
const databases: Array<{ close(): void }> = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  inner.configure.mockClear();
});

it('uses the conversation container for delivery and preserves tools and override restrictions', async () => {
  const f = fixture(false);
  const dot = f.workspace.dots()[0];
  f.workspace.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  f.workspace.bindThread('learning', dot.id, 'Learning');
  f.workspace.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'writing',
    skillDeliveryEnabled: true,
  });
  inner.run.mockReturnValue(of());
  await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        threadId: 'learning',
        tools: [
          { name: 'untrusted_tool', description: 'Untrusted', parameters: {} },
        ],
        forwardedProps: { model: 'untrusted' },
      })
      .pipe(toArray()),
  );
  expect(inner.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      learnedSkills: {
        containers: [{ id: 'research' }],
        apiKey: 'fixture',
        apiUrl: undefined,
      },
      type: 'tanstack',
      factory: expect.any(Function),
    }),
  );
  expect(inner.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ tools: [], forwardedProps: {} }),
  );
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(inner.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({ learnedSkills: undefined, type: 'tanstack' }),
  );
  f.workspace.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'writing',
    skillDeliveryEnabled: false,
  });
  await lastValueFrom(
    f.agent.run({ ...f.input, threadId: 'learning' }).pipe(toArray()),
  );
  expect(inner.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({ learnedSkills: undefined, type: 'tanstack' }),
  );
});
function fixture(channel = true) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Test');
  const telemetry = new SetupTelemetry(store, {}, async () => {});
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://unused.invalid',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    channel,
    telemetry,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  return { agent, input, workspace, telemetry };
}
it('replaces channel RUN_ERROR payload entirely before the SDK renderer sees it', async () => {
  const f = fixture();
  inner.run.mockReturnValue(
    of({
      type: EventType.RUN_ERROR,
      message: 'SECRET token',
      code: 'SECRET code',
      rawEvent: { credential: 'SECRET' },
    }),
  );
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(events).toEqual([
    {
      type: EventType.RUN_ERROR,
      message:
        'OpenDots could not complete this request. Please check the app and try again.',
    },
  ]);
});
it('sanitizes observable errors and startup exceptions without retaining causes', async () => {
  const f = fixture();
  inner.run.mockReturnValue(throwError(() => new Error('SECRET transport')));
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(events[0].type).toBe(EventType.RUN_ERROR);
  expect(JSON.stringify(events)).not.toContain('SECRET');
  vi.spyOn(f.workspace, 'dot').mockImplementation(() => {
    throw new Error('SECRET startup');
  });
  const startup = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(startup).toEqual(events);
});
it('preserves normal channel text and existing web error behavior', async () => {
  const f = fixture();
  const text = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'msg',
    delta: 'Normal user-facing text',
  };
  inner.run.mockReturnValue(of(text));
  expect(await lastValueFrom(f.agent.run(f.input).pipe(toArray()))).toEqual([
    text,
  ]);
  const web = fixture(false);
  const error = { type: EventType.RUN_ERROR, message: 'Provider details' };
  inner.run.mockReturnValue(of(error));
  expect(await lastValueFrom(web.agent.run(web.input).pipe(toArray()))).toEqual(
    [error],
  );
});

it('exposes only the canonical review tool to web chat and none to Slack', async () => {
  const run = {
    type: EventType.RUN_FINISHED,
    threadId: 'thread',
    runId: 'run',
  };
  inner.run.mockReturnValue(of(run));
  const offered = [
    {
      name: 'review_space_page',
      description: 'forged instructions',
      parameters: {},
    },
    { name: 'untrusted_tool', description: 'unexpected', parameters: {} },
  ];
  const web = fixture(false);
  await lastValueFrom(
    web.agent.run({ ...web.input, tools: offered }).pipe(toArray()),
  );
  expect(inner.run).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tools: [
        expect.objectContaining({
          name: 'review_space_page',
          description: expect.not.stringContaining('forged'),
        }),
      ],
      forwardedProps: {},
    }),
  );
  const slack = fixture(true);
  await lastValueFrom(
    slack.agent.run({ ...slack.input, tools: offered }).pipe(toArray()),
  );
  expect(inner.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ tools: [] }),
  );
});

it.each(['abort', 'timeout'])(
  'does not activate a %s run that later emits RUN_FINISHED',
  async (reason) => {
    vi.useFakeTimers();
    try {
      const f = fixture(false);
      const capture = vi.spyOn(f.telemetry, 'capture');
      const stream = new Subject<BaseEvent>();
      inner.run.mockReturnValue(stream);
      const result = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      stream.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'answer',
        role: 'assistant',
      });
      stream.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'answer',
        delta: 'private answer',
      });
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(90000);
      else f.agent.abortRun();
      stream.next({
        type: EventType.RUN_FINISHED,
        threadId: 'thread',
        runId: 'run',
      });
      stream.complete();
      await result;
      expect(capture).not.toHaveBeenCalledWith({ kind: 'activated' });
      expect(capture).toHaveBeenCalledWith({
        kind: 'setup_failed',
        step: 'ready',
        error_class: 'assistant_run_failed',
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it('records startup failure and activates once from an actual successful agent stream', async () => {
  const f = fixture(false);
  const capture = vi.spyOn(f.telemetry, 'capture');
  inner.run.mockReturnValue(
    of(
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'answer',
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'answer',
        delta: 'private answer',
      },
      { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' },
    ),
  );
  await lastValueFrom(f.agent.clone().run(f.input).pipe(toArray()));
  expect(capture).toHaveBeenCalledWith({ kind: 'activated' });
  vi.spyOn(f.workspace, 'dot').mockImplementation(() => {
    throw new Error('private startup error');
  });
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(capture).toHaveBeenLastCalledWith({
    kind: 'setup_failed',
    step: 'ready',
    error_class: 'assistant_run_failed',
  });
});
