import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, of, throwError, toArray } from 'rxjs';
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

it('never configures cloud learned skills and preserves tool and override restrictions', async () => {
  const f = fixture(false);
  const dot = f.workspace.dots()[0];
  f.workspace.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  inner.run.mockReturnValue(of());
  await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        tools: [
          { name: 'untrusted_tool', description: 'Untrusted', parameters: {} },
        ],
        forwardedProps: { model: 'untrusted' },
      })
      .pipe(toArray()),
  );
  expect(inner.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'tanstack',
      factory: expect.any(Function),
    }),
  );
  expect(inner.configure.mock.lastCall?.[0]).not.toHaveProperty(
    'learnedSkills',
  );
  expect(inner.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ tools: [], forwardedProps: {} }),
  );
});
function fixture(channel = true) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Test');
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://unused.invalid',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    channel,
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
  return { agent, input, workspace };
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
