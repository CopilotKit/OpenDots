import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { SteeringInbox } from '../src/server/steering.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

function fixture(mode: 'unattended' | 'confirm', steering?: SteeringInbox) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Continue');
  const policy = join(
    mkdtempSync(join(tmpdir(), 'dots-policy-')),
    'confirmation-policy.json',
  );
  writeFileSync(policy, JSON.stringify({ mode }));
  const mcp = {
    configured: false,
    localConfirmationConfig: () => ({ path: policy, defaultConfirm: true }),
    tools: async () => [],
  };
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      mcp,
      steering,
    } as unknown as PlatformConfig,
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [
      {
        id: 'user',
        role: 'user',
        content: 'Create pages Trade 1 and Trade 2.',
      },
    ],
  };
  return { workspace, dot, agent, input };
}

const page = (title: string) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${title}`,
          type: 'function',
          function: {
            name: 'create_space_page',
            arguments: JSON.stringify({ title, content: 'Saved' }),
          },
        },
      ],
    },
    'tool_calls',
  );
const say = (content: string) => completion({ role: 'assistant', content });

function script(replies: Array<() => Response>) {
  const bodies: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body ?? ''));
    const next = replies.shift();
    if (!next) throw new Error('Model called more often than scripted');
    return next();
  });
  return bodies;
}

const lastUser = (body: string) => {
  const sent = JSON.parse(body) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  return String(sent.messages.filter((m) => m.role === 'user').at(-1)?.content);
};
const pages = (f: ReturnType<typeof fixture>) =>
  f.workspace.pages
    .list(f.dot.spaceId)
    .map((p) => p.title)
    .filter((t) => t.startsWith('Trade'))
    .sort();

it('continues an unattended task past a prose reply, restating the goal, until the goal is confirmed', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('Trade 1 is saved. Shall I create Trade 2?'),
    () => page('Trade 2'),
    () => say('TASK COMPLETE: both pages saved.'),
    () => say('TASK COMPLETE: the space lists Trade 1 and Trade 2.'),
  ]);
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(bodies).toHaveLength(5);
  expect(lastUser(bodies[2])).toContain(
    'Keep working toward my goal: «Create pages Trade 1 and Trade 2.»',
  );
  expect(lastUser(bodies[4])).toContain('Before finishing, check your claim');
  // The client sees one run.
  expect(events.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(
    1,
  );
  expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(
    1,
  );
  expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
});

it('leaves confirming owners in charge: a prose reply ends the run as before', async () => {
  const f = fixture('confirm');
  const bodies = script([
    () => page('Trade 1'),
    () => say('Trade 1 is saved. Shall I create Trade 2?'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(bodies).toHaveLength(2);
});

it('keeps working when an early completion claim does not survive the goal check', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('TASK COMPLETE: Trade 1 is saved.'),
    () => page('Trade 2'),
    () => say('TASK COMPLETE: Trade 1 and Trade 2 are saved.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(lastUser(bodies[2])).toContain(
    'check your claim against my goal: «Create pages Trade 1 and Trade 2.»',
  );
  expect(bodies).toHaveLength(4);
});

it('treats a claim followed by a checking tool call as a claim, not a reason to keep acting', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('Trade 1 placed.'),
    () => page('Trade 2'),
    // Claims completion, then calls a tool to double-check in the same turn.
    () =>
      completion(
        {
          role: 'assistant',
          content: 'TASK COMPLETE: both trades placed.',
          tool_calls: [
            {
              index: 0,
              id: 'call-check',
              type: 'function',
              function: {
                name: 'create_space_page',
                arguments: JSON.stringify({ title: 'Check', content: 'x' }),
              },
            },
          ],
        },
        'tool_calls',
      ),
    () => say(''),
    () => say('TASK COMPLETE: Trade 1 and Trade 2 are listed.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(bodies).toHaveLength(6);
  expect(lastUser(bodies[5])).toContain('Before finishing, check your claim');
  expect(lastUser(bodies[5])).toContain('take no further actions');
});

it('checks a failure claim once before giving up', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('TASK FAILED: I cannot find the page tool.'),
    () => say('TASK FAILED: there is still no way to create Trade 2.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(bodies).toHaveLength(3);
  expect(lastUser(bodies[2])).toContain('Before finishing, check your claim');
});

it('answers without thinking after a turn that only reasoned', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('Trade 1 saved.'),
    // A whole turn of hidden reasoning with no reply and no action.
    () => say(''),
    () => page('Trade 2'),
    () => say('TASK COMPLETE: both pages saved.'),
    () => say('TASK COMPLETE: Trade 1 and Trade 2 are listed.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(bodies).toHaveLength(6);
  const effort = (n: number) => JSON.parse(bodies[n]).reasoning_effort;
  expect(effort(2)).toBeUndefined();
  expect(effort(3)).toBe('none');
  expect(effort(5)).toBeUndefined();
});

it('runs well past 25 continuations on a long goal', async () => {
  const f = fixture('unattended');
  const replies: Array<() => Response> = [];
  for (let n = 1; n <= 40; n++)
    replies.push(
      () => page(`Trade ${n}`),
      () => say(`Trade ${n} placed.`),
    );
  replies.push(
    () => say('TASK COMPLETE: 40 trades placed.'),
    () => say('TASK COMPLETE: the space lists Trade 1 to Trade 40.'),
  );
  const bodies = script(replies);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toHaveLength(40);
  expect(bodies).toHaveLength(82);
});

it('pushes harder after turns without action, then stops after five in a row', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => page('Trade 1'),
    () => say('Saved. What next?'),
    () => say('Status update: balance looks fine, analysing the chart...'),
    () => say('Goal check: still analysing.'),
    () => say('Please choose.'),
    () => say('Still waiting.'),
    () => say('Still analysing.'),
  ]);
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(bodies).toHaveLength(7);
  // A written analysis with no action is followed by a turn without thinking.
  expect(JSON.parse(bodies[3]).reasoning_effort).toBe('none');
  // Only every other idle turn: a model stuck without thinking gets it back.
  expect(JSON.parse(bodies[4]).reasoning_effort).toBeUndefined();
  expect(JSON.parse(bodies[5]).reasoning_effort).toBe('none');
  expect(lastUser(bodies[3])).toContain('only a tool call does');
  expect(lastUser(bodies[2])).not.toContain('took no action');
  expect(lastUser(bodies[3])).toContain('Your last reply took no action');
  expect(lastUser(bodies[4])).toContain('Your last 2 replies took no action');
  expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(
    1,
  );
});

it('acts after a first turn that only reasoned, answering without thinking', async () => {
  const f = fixture('unattended');
  const bodies = script([
    // The very first turn ends on hidden reasoning: no reply, no action.
    () => say(''),
    () => page('Trade 1'),
    () => page('Trade 2'),
    () => say('TASK COMPLETE: both pages saved.'),
    () => say('TASK COMPLETE: Trade 1 and Trade 2 are listed.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(bodies).toHaveLength(5);
  const effort = (n: number) => JSON.parse(bodies[n]).reasoning_effort;
  expect(effort(0)).toBeUndefined();
  expect(effort(1)).toBe('none');
  expect(lastUser(bodies[1])).toContain('Keep working toward my goal');
});

it('starts a task the model first refused as impossible to loop', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () =>
      say(
        'The task cannot be automated with the available tools; they cannot loop. Use Selenium instead.',
      ),
    () => page('Trade 1'),
    () => page('Trade 2'),
    () => say('TASK COMPLETE: both pages saved.'),
    () => say('TASK COMPLETE: Trade 1 and Trade 2 are listed.'),
  ]);
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(lastUser(bodies[1])).toContain('You can act now');
  // A completion claimed after acting still gets the goal check.
  expect(lastUser(bodies[4])).toContain('Before finishing, check your claim');
  expect(bodies).toHaveLength(5);
});

it('lets a plain conversational answer end after one short check', async () => {
  const f = fixture('unattended');
  const bodies = script([
    () => say('Hello! How can I help?'),
    () => say('TASK COMPLETE'),
  ]);
  await lastValueFrom(
    f.agent
      .run({ ...f.input, messages: [{ id: 'u', role: 'user', content: 'hi' }] })
      .pipe(toArray()),
  );
  expect(bodies).toHaveLength(2);
  expect(lastUser(bodies[1])).toContain('You can act now');
});

it('does not end on a misread balance: the page text decides (the 23:02 run)', async () => {
  const f = fixture('unattended');
  let shown = 'QT Demo\nUSD\n363.84\nTrades\nOpened\nClosed\nNo opened trades';
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () => shown,
  });
  const goal =
    'we have 50 in cash in our demo account, trade it the best you can till you get $500 or lose 90% of the account value.';
  const bodies = script([
    () => page('Trade 1'),
    // Vision read the 1.1330 price as the balance.
    () =>
      say(
        'TASK COMPLETE: the current account balance is $1,330.00, above the $500 target.',
      ),
    () => say('TASK COMPLETE: the balance is $1,330.00.'),
    () => {
      shown = 'QT Demo\nUSD\n520.00\nTrades\nOpened\nClosed\nNo opened trades';
      return page('Trade 2');
    },
    () => say('TASK COMPLETE: balance $520.00.'),
    () => say('TASK COMPLETE: the page shows $520.00.'),
  ]);
  const events = await lastValueFrom(
    f.agent
      .run({ ...f.input, messages: [{ id: 'u', role: 'user', content: goal }] })
      .pipe(toArray()),
  );
  expect(lastUser(bodies[3])).toContain(
    'Not finished: the balance on the page right now is $363.84',
  );
  expect(lastUser(bodies[3])).toContain('not from a screenshot');
  // The page then shows $520: the run ends there in code.
  expect(bodies).toHaveLength(5);
  expect(pages(f)).toEqual(['Trade 1', 'Trade 2']);
  expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(
    1,
  );
});

it('still finishes normally when the page text has no balance', async () => {
  const f = fixture('unattended');
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () => 'Some page without an account balance',
  });
  const bodies = script([
    () => page('Trade 1'),
    () => say('TASK COMPLETE: balance $520.00.'),
    () => say('TASK COMPLETE: the page shows $520.00.'),
  ]);
  await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        messages: [
          {
            id: 'u',
            role: 'user',
            content: 'we have 50, get $500 or lose 90%',
          },
        ],
      })
      .pipe(toArray()),
  );
  expect(bodies).toHaveLength(3);
});

it('ends the run in code once the page shows the goal, instead of trading on (the 08:05 run)', async () => {
  const f = fixture('unattended');
  let shown = 'QT Demo\nUSD\n417.79\nTrades\nOpened\nClosed\nNo opened trades';
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () => shown,
  });
  const goal =
    'we have $119 in cash in our demo account, trade it the best you can till you get $500 or lose 90% of the account value ($50)';
  const bodies = script([
    () => page('Trade 1'),
    () => say('Placed a BUY.'),
    () => {
      // A trade is still open: the goal check waits for it.
      shown =
        'QT Demo\nUSD\n523.44\nTrades\nOpened\nClosed\nEUR/USD OTC +92%\n00:05\n$10';
      return page('Trade 2');
    },
    () => say('Placed another BUY.'),
    () => {
      shown = 'QT Demo\nUSD\n523.44\nTrades\nOpened\nClosed\nNo opened trades';
      return page('Trade 3');
    },
    () => say('Placed another BUY.'),
  ]);
  const events = await lastValueFrom(
    f.agent
      .run({ ...f.input, messages: [{ id: 'u', role: 'user', content: goal }] })
      .pipe(toArray()),
  );
  expect(bodies).toHaveLength(6);
  const said = events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as unknown as { delta: string }).delta)
    .join('');
  expect(said).toContain(
    'TASK COMPLETE: Goal reached: the page shows $523.44 (goal $500.00). Stopping here.',
  );
  expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(
    1,
  );
});

it('ends the run in code at the stop level', async () => {
  const f = fixture('unattended');
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () =>
      'QT Demo\nUSD\n10.00\nTrades\nOpened\nClosed\nNo opened trades',
  });
  const bodies = script([() => page('Trade 1'), () => say('Placed a SELL.')]);
  const events = await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        messages: [
          {
            id: 'u',
            role: 'user',
            content:
              'we have $119 in cash, get $500 or lose 90% of the account value ($50)',
          },
        ],
      })
      .pipe(toArray()),
  );
  expect(bodies).toHaveLength(2);
  expect(
    events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join(''),
  ).toContain('Stop level reached: the page shows $10.00 (stop at $11.90)');
});

it('ends the run at the trailing stop, keeping the locked profit', async () => {
  const f = fixture('unattended');
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () =>
      'QT Demo\nUSD\n2750.40\nTrades\nOpened\nClosed\nNo opened trades',
    // Start $500, peak $5,000 seen earlier: half the $4,500 profit is locked at $2,750.
    tradingSession: () => ({
      time: Date.now() / 1000,
      start: 500,
      peak: 5000,
      locked: 2750,
    }),
  });
  const bodies = script([() => page('Trade 1'), () => say('Placed a BUY.')]);
  const events = await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        messages: [
          {
            id: 'u',
            role: 'user',
            content:
              'we have $500 in cash, get $10000 or lose 75% of the account value ($125)',
          },
        ],
      })
      .pipe(toArray()),
  );
  expect(bodies).toHaveLength(2);
  expect(
    events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join(''),
  ).toContain(
    'TASK COMPLETE: Trailing stop reached: the page shows $2,750.40, back at the locked $2,750.00',
  );
});

it('tells the model the real page balance every turn (the 13:58 run)', async () => {
  const f = fixture('unattended');
  Object.assign((f.agent as unknown as { config: PlatformConfig }).config, {
    browserText: async () =>
      'QT Demo\nUSD\n26.80\nTrades\nOpened\nClosed\nNo opened trades',
  });
  const bodies = script([
    () => page('Trade 1'),
    () => say('Balance is now $513.00 after the BUY.'),
    () => say('TASK FAILED: stopping.'),
    () => say('TASK FAILED: stopping.'),
  ]);
  await lastValueFrom(
    f.agent
      .run({
        ...f.input,
        messages: [
          {
            id: 'u',
            role: 'user',
            content: 'we have $64.74 in cash, get $300 or lose 90%',
          },
        ],
      })
      .pipe(toArray()),
  );
  expect(lastUser(bodies[2])).toContain(
    'Balance on the page right now: $26.80. Use this, not earlier figures',
  );
});

it('reads an owner message sent mid-run after the current step, shows it, and keeps it with the goal', async () => {
  const steering = new SteeringInbox();
  const f = fixture('unattended', steering);
  const bodies = script([
    () => {
      // The owner adds a to-do while the first page is being made.
      steering.push('thread', 'Also create Trade 3.');
      return page('Trade 1');
    },
    () => page('Trade 3'),
    () => say('TASK COMPLETE: Trade 1 and Trade 3 saved.'),
    () => say('TASK COMPLETE: the space lists Trade 1 and Trade 3.'),
  ]);
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(pages(f)).toEqual(['Trade 1', 'Trade 3']);
  // The turn ended after the tool step; the next call carries the message.
  expect(lastUser(bodies[1])).toBe('Also create Trade 3.');
  // Later nudges restate it with the goal.
  expect(lastUser(bodies[3])).toContain('owner updates since');
  expect(lastUser(bodies[3])).toContain('Also create Trade 3.');
  // It shows in the chat as the owner's message, inside one run.
  expect(
    events.some(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as { role?: string }).role === 'user',
    ),
  ).toBe(true);
  expect(events.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(
    1,
  );
  expect(steering.has('thread')).toBe(false);
});
