import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import {
  ajRoutes,
  pageAccount,
  pocketGoal,
  spokenResult,
  type AjDeps,
} from '../src/server/aj-routes.js';
import { parseGoalNumbers } from '../src/server/goal-numbers.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const DEMO = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/';
const REAL = 'https://pocketoption.com/en/cabinet/quick-high-low/';

function fixture(page = { url: DEMO, text: 'QT Demo\nUSD\n1,000.00' }) {
  const dir = mkdtempSync(join(tmpdir(), 'aj-'));
  const store = new Store(':memory:');
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const threads = new Map<string, string>();
  const turns: { thread: string; prompt: string; signal: AbortSignal }[] = [];
  let release: (text: string) => void = () => {};
  let reviews = [
    {
      id: 'r1',
      title: 'Retry the settle job',
      summary: 'Retries twice.',
      passed: true,
      status: 'pending',
      createdAt: 5_000,
    },
  ];
  const deps: AjDeps = {
    store,
    dots: () => [
      { id: 'dev', name: 'Developer', toolGroups: ['developer'] },
      { id: 'map', name: 'Site Mapper', toolGroups: ['site_mapping'] },
      { id: 'trader', name: 'Trader', toolGroups: ['trading', 'web'] },
    ],
    createConversation: async (dotId) => {
      const id = `t${threads.size + 1}`;
      threads.set(id, dotId);
      return { id };
    },
    bindTask: (taskId, threadId) => threads.set(`task:${taskId}`, threadId),
    taskThread: (taskId) => threads.get(`task:${taskId}`),
    threadDot: (threadId) => threads.get(threadId),
    abortTask: () => {},
    turn: (thread, prompt, signal) =>
      new Promise((done, fail) => {
        turns.push({ thread, prompt, signal });
        release = done;
        signal.addEventListener('abort', () => fail(signal.reason));
      }),
    pageText: async () => page.text,
    pageUrl: async () => page.url,
    python: async (args) =>
      args[1] === 'problems'
        ? { problems: [{ at: 1, kind: 'job', title: 'NBA Totals failed' }] }
        : { speech: 'All quiet.' },
    reviews: () => reviews,
    applyReview: async (id) => {
      reviews = reviews.map((r) =>
        r.id === id ? { ...r, status: 'applied' } : r,
      );
      return { applied: id };
    },
    rejectReview: async (id) => ({ rejected: id }),
    stateFile: join(dir, 'aj.json'),
    modeFile: join(dir, 'trading-mode.json'),
  };
  writeFileSync(deps.modeFile, JSON.stringify({ obviousOnly: true }));
  const app = ajRoutes(deps);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const mode = () => JSON.parse(readFileSync(deps.modeFile, 'utf8'));
  return {
    app,
    post,
    deps,
    turns,
    mode,
    page,
    finish: (t: string) => release(t),
  };
}

const run = {
  account: 'demo',
  market: 'otc',
  goal: 100,
  lossLimit: 50,
  minutes: 60,
};
const settle = () => new Promise((done) => setTimeout(done, 20));

it('tells the account from the address, and refuses when the header contradicts it', () => {
  expect(pageAccount(DEMO, 'QT Demo USD 50')).toBe('demo');
  expect(pageAccount(REAL, 'QT Real USD 50')).toBe('real');
  expect(pageAccount(REAL, 'QT Demo USD 50')).toBeUndefined();
  expect(pageAccount('https://pocketoption.com/en/', '')).toBeUndefined();
});

it('words the goal so the run pins the start, the goal and the loss limit', () => {
  const goal = pocketGoal({
    id: 'r',
    account: 'demo',
    market: 'otc',
    start: 1000,
    target: 1100,
    stop: 950,
    startedAt: 0,
    until: 3600,
    conversation: 't',
  });
  expect(parseGoalNumbers(goal)).toMatchObject({
    start: 1000,
    target: 1100,
    stop: 950,
  });
  expect(goal).toContain('OTC pairs only');
});

it('starts a demo run with the limits written for the trade guard, and clears them when it ends', async () => {
  const f = fixture();
  const response = await f.post('/aj/pocket', run);
  expect(response.status).toBe(201);
  expect(f.mode()).toMatchObject({
    obviousOnly: true,
    run: { account: 'demo', market: 'otc' },
  });
  expect(f.turns[0].prompt).toContain('We have $1,000.00');
  expect(f.turns[0].prompt).toContain('reaches $1,100.00');
  expect(f.turns[0].prompt).toContain('falls below $950.00');
  expect((await f.post('/aj/pocket', run)).status).toBe(409);
  f.finish('Goal reached: the page shows $1,104.00. TASK COMPLETE');
  await settle();
  expect(f.mode()).toEqual({ obviousOnly: true });
  const status = await (await f.app.request('/aj/pocket')).json();
  expect(status).toMatchObject({
    active: false,
    last: { how: 'goal reached' },
  });
});

it('refuses a run without both limits, on the wrong account, or real money without confirmation', async () => {
  const f = fixture();
  expect(
    (await f.post('/aj/pocket', { account: 'demo', market: 'otc', goal: 100 }))
      .status,
  ).toBe(400);
  const wrong = await f.post('/aj/pocket', {
    ...run,
    account: 'real',
    confirmRealMoney: true,
  });
  expect(wrong.status).toBe(409);
  expect((await wrong.json()).error).toContain('shows the demo account');
  const real = fixture({ url: REAL, text: 'QT Real\nUSD\n500' });
  expect(
    (await real.post('/aj/pocket', { ...run, account: 'real' })).status,
  ).toBe(400);
  expect(
    (
      await real.post('/aj/pocket', {
        ...run,
        account: 'real',
        confirmRealMoney: true,
      })
    ).status,
  ).toBe(201);
  expect((await f.post('/aj/pocket', { ...run, lossLimit: 1000 })).status).toBe(
    400,
  );
});

it('stops a run on request and records why', async () => {
  const f = fixture();
  await f.post('/aj/pocket', run);
  expect((await f.post('/aj/pocket/stop', {})).status).toBe(200);
  await settle();
  const status = await (await f.app.request('/aj/pocket')).json();
  expect(status.last.how).toBe('stopped by the owner');
  expect(f.mode().run).toBeUndefined();
});

it('hands a task to a Dot by name and keeps browser Dots off a running Pocket Option run', async () => {
  const f = fixture();
  const response = await f.post('/aj/tasks', {
    dot: 'developer dot',
    task: 'Fix the NBA settle job',
  });
  expect(response.status).toBe(201);
  const task = await response.json();
  expect(task.dot).toBe('Developer');
  const view = await (await f.app.request(`/aj/tasks/${task.id}`)).json();
  expect(view).toMatchObject({
    status: 'queued',
    task: 'Fix the NBA settle job',
  });
  expect(f.deps.store.task(task.id)?.prompt).toContain('comes from AJ');
  expect(f.deps.store.task(task.id)?.prompt).toContain('submit it for review');
  expect(
    (await f.post('/aj/tasks', { dot: 'Nobody', task: 'hello there' })).status,
  ).toBe(404);
  await f.post('/aj/pocket', run);
  expect(
    (await f.post('/aj/tasks', { dot: 'Site Mapper', task: 'map example.com' }))
      .status,
  ).toBe(409);
});

it('reports problems and finished work since a time', async () => {
  const f = fixture();
  await f.post('/aj/pocket', run);
  f.finish('Stop level reached: the page shows $949.00.');
  await settle();
  const news = await (await f.app.request('/aj/news?since=0')).json();
  expect(news.problems[0].title).toBe('NBA Totals failed');
  expect(news.finished[0]).toMatchObject({ how: 'loss limit reached' });
});

it('reads only the answer out of a Dot reply: no thinking, nothing before the marker', () => {
  const reply = `<think>${'reasoning '.repeat(500)}</think>

Checked the job. TASK COMPLETE: The settle job runs again; the cause was a timeout.`;
  expect(spokenResult(reply)).toBe(
    'The settle job runs again; the cause was a timeout.',
  );
  expect(spokenResult('<think>still thinking')).toBeNull();
  expect(spokenResult('</think>TASK COMPLETE')).toBe('Done.');
  expect(spokenResult('TASK FAILED: the site needs a login.')).toBe(
    'the site needs a login.',
  );
  expect(spokenResult('Plain answer.')).toBe('Plain answer.');
});

it("reads the Developer's waiting changes aloud and applies one by its number", async () => {
  const f = fixture();
  const list = await (await f.app.request('/aj/reviews')).json();
  expect(list.speech).toBe(
    '1 Developer change waiting for review: 1, Retry the settle job.',
  );
  const applied = await f.post('/aj/reviews/1/apply', {});
  expect(await applied.json()).toMatchObject({
    applied: 'r1',
    title: 'Retry the settle job',
  });
  expect((await f.post('/aj/reviews/1/apply', {})).status).toBe(404);
});

it('counts a new Developer review as finished work', async () => {
  const f = fixture();
  const news = await (await f.app.request('/aj/news?since=0')).json();
  expect(
    news.finished.some((x: { kind?: string }) => x.kind === 'review'),
  ).toBe(true);
});
