import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { money, pageBalance } from './goal-numbers.js';
import type { Store } from './store.js';
import type { Platform } from './platform.js';
import type { Runner } from './runner.js';

/**
 * The doorway for AJ, the owner's voice assistant (AIVoice/Jvis): the trading and
 * betting report in spoken sentences, problems worth interrupting for, tasks
 * handed to any Dot, and Pocket Option runs with limits the owner names out loud.
 *
 * AJ decides who may ask (admin voice, a spoken yes); these routes enforce what
 * must hold whoever asks: a run names its account, market, goal and loss limit,
 * real money needs an explicit confirmation flag, the account on the page must be
 * the one named, and nothing else uses the shared browser while a run trades.
 */
export interface AjDot {
  id: string;
  name: string;
  toolGroups?: string[];
}
export interface AjDeps {
  store: Store;
  dots(): AjDot[];
  createConversation(dotId: string, title: string): Promise<{ id: string }>;
  bindTask(taskId: string, threadId: string): void;
  taskThread(taskId: string): string | undefined;
  threadDot(threadId: string): string | undefined;
  abortTask(taskId: string): void;
  turn(threadId: string, prompt: string, signal: AbortSignal): Promise<string>;
  pageText(): Promise<string | undefined>;
  pageUrl(): Promise<string | undefined>;
  python(args: string[]): Promise<Record<string, unknown>>;
  reviews(): AjReview[];
  applyReview(id: string): Promise<Record<string, unknown>>;
  rejectReview(id: string): Promise<Record<string, unknown>>;
  stateFile: string;
  modeFile: string;
  now?: () => number;
}

export interface AjReview {
  id: string;
  title: string;
  summary: string;
  passed: boolean;
  status: string;
  createdAt: number;
}
interface AjTask {
  id: string;
  dot: string;
  task: string;
  at: number;
}
interface PocketRun {
  id: string;
  account: 'demo' | 'real';
  market: 'otc' | 'real' | 'any';
  start: number;
  target: number;
  stop: number;
  startedAt: number;
  until: number;
  conversation: string;
  endedAt?: number;
  how?: string;
  endBalance?: number;
  result?: string;
}
const DEVELOPER_NOTE =
  "Make the change in your Developer workspace, run the checks, and submit it for review with a plain title and a summary of what changed and why: the summary is recorded in the owner's vault, and the owner applies the change. Never apply it yourself.";
interface AjState {
  tasks: AjTask[];
  pocket: { current?: PocketRun; last?: PocketRun };
}

// Dots whose tools drive the one shared browser tab (or the screen): only one
// of them may work at a time, and none while a Pocket Option run is trading.
const SHARED_SCREEN = ['browser', 'trading', 'site_mapping', 'pc_control'];
const RESULT_CHARS = 1200;
const TASK_NOTE =
  'This task comes from AJ, the owner\'s voice assistant, on the owner\'s behalf. Do not place trades or bets, send messages, or buy anything as part of it. When you finish, reply "TASK COMPLETE:" followed by a short plain summary the owner can listen to: what you did, what you found, and anything that needs them. If it cannot be done, reply "TASK FAILED:" and why.';

/**
 * What a Dot's reply says, for AJ to read aloud: no reasoning block (some local
 * models write their thinking first, 7,000 characters of it before a two-word
 * answer), and only what follows the last TASK COMPLETE / TASK FAILED marker.
 */
export function spokenResult(text: string | null | undefined): string | null {
  if (!text) return null;
  let answer = text.includes('</think>')
    ? text.slice(text.lastIndexOf('</think>') + 8)
    : text.replace(/<think>[\s\S]*$/, '');
  const marker = /TASK (COMPLETE|FAILED)\b:?/gi;
  let last: RegExpExecArray | null = null;
  for (let m = marker.exec(answer); m; m = marker.exec(answer)) last = m;
  if (last) {
    const after = answer.slice(last.index + last[0].length).trim();
    answer =
      after ||
      (last[1].toUpperCase() === 'FAILED' ? 'It could not be done.' : 'Done.');
  }
  return answer.trim().slice(0, RESULT_CHARS) || null;
}

export function pageAccount(
  url: string | undefined,
  text: string | undefined,
): 'demo' | 'real' | undefined {
  const path = url ? new URL(url).pathname : '';
  const byUrl = /\/cabinet\/demo-/.test(path)
    ? 'demo'
    : /\/cabinet\//.test(path)
      ? 'real'
      : undefined;
  const head = (text ?? '').slice(0, 5000);
  const byText = /QT Demo/i.test(head)
    ? 'demo'
    : /QT Real/i.test(head)
      ? 'real'
      : undefined;
  return byText && byUrl && byText !== byUrl ? undefined : byUrl;
}

/** The goal in the words OpenDots' goal parser pins: start, target and stop. */
export function pocketGoal(run: PocketRun): string {
  const account = run.account === 'demo' ? 'demo' : 'real money';
  const market =
    run.market === 'otc'
      ? 'OTC pairs only'
      : run.market === 'real'
        ? 'real (non-OTC) pairs only'
        : 'OTC or real pairs, whichever looks clearer';
  const until = new Date(run.until * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Trade on Pocket Option, on the ${account} account, ${market}. We have ${money(run.start)}. Keep trading until the balance reaches ${money(run.target)}; stop if it falls below ${money(run.stop)}. The run ends at ${until} at the latest. Never switch accounts.`;
}

export function ajRoutes(deps: AjDeps) {
  const app = new Hono();
  const now = () => (deps.now ?? (() => Date.now() / 1000))();
  const load = (): AjState => {
    try {
      const data = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as AjState;
      return { tasks: data.tasks ?? [], pocket: data.pocket ?? {} };
    } catch {
      return { tasks: [], pocket: {} };
    }
  };
  const save = (state: AjState) => {
    mkdirSync(dirname(deps.stateFile), { recursive: true });
    writeFileSync(deps.stateFile, JSON.stringify(state, null, 1));
  };
  const setRun = (run: Record<string, unknown> | undefined) => {
    let mode: Record<string, unknown>;
    try {
      mode = JSON.parse(readFileSync(deps.modeFile, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      mode = {};
    }
    if (run) mode.run = run;
    else delete mode.run;
    mkdirSync(dirname(deps.modeFile), { recursive: true });
    writeFileSync(deps.modeFile, JSON.stringify(mode));
  };
  const findDot = (name: string) => {
    const key = name
      .trim()
      .toLowerCase()
      .replace(/\s+dot$/, '');
    const dots = deps.dots();
    return (
      dots.find((d) => d.id === name || d.name.toLowerCase() === key) ??
      dots.find((d) => d.name.toLowerCase().startsWith(key))
    );
  };
  const usesScreen = (dot?: AjDot) =>
    !!dot?.toolGroups?.some((group) => SHARED_SCREEN.includes(group));
  const busyScreenTask = () =>
    deps.store
      .tasks()
      .filter((task) => task.status === 'running' || task.status === 'queued')
      .find((task) => {
        const thread = deps.taskThread(task.id);
        const dotId = thread ? deps.threadDot(thread) : undefined;
        return usesScreen(deps.dots().find((d) => d.id === dotId));
      });
  const taskView = (entry: AjTask) => {
    const detail = deps.store.detail(entry.id);
    const run = detail?.runs[0];
    return {
      ...entry,
      status: detail?.task.status ?? 'gone',
      result: spokenResult(run?.result?.text),
      error: detail?.task.error ?? null,
      updatedAt: detail ? detail.task.updatedAt / 1000 : null,
    };
  };

  // A run cut off by a restart cannot be resumed honestly: close it on the record
  // and lift its limits, so the trader is not left bound to a dead run.
  {
    const state = load();
    if (state.pocket.current) {
      state.pocket.last = {
        ...state.pocket.current,
        endedAt: now(),
        how: 'interrupted: OpenDots restarted during the run',
      };
      delete state.pocket.current;
      save(state);
      setRun(undefined);
    }
  }
  let controller: AbortController | undefined;
  let stopReason = '';

  app.get('/aj/report', async (c) =>
    c.json(await deps.python(['localtools/aj_report.py', 'report'])),
  );

  app.get('/aj/positions', async (c) =>
    c.json(await deps.python(['localtools/aj_report.py', 'positions'])),
  );

  // The Developer's changes waiting for the owner, said in words; applying one by
  // voice is the owner's own approval (AJ asks for a spoken yes first).
  app.get('/aj/reviews', (c) => {
    const pending = deps.reviews().filter((r) => r.status === 'pending');
    return c.json({
      reviews: pending.map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary.slice(0, 600),
        passed: r.passed,
        createdAt: r.createdAt / 1000,
      })),
      speech: pending.length
        ? `${pending.length} Developer change${pending.length === 1 ? '' : 's'} waiting for review: ${pending
            .slice(0, 5)
            .map(
              (r, i) =>
                `${i + 1}, ${r.title}${r.passed ? '' : ' (its checks failed)'}`,
            )
            .join('; ')}.`
        : 'No Developer changes are waiting for review.',
    });
  });
  app.post('/aj/reviews/:id/:action', async (c) => {
    const action = c.req.param('action');
    const wanted = c.req.param('id');
    const pending = deps.reviews().filter((r) => r.status === 'pending');
    // "latest" or a number from the spoken list, so nobody has to say an id.
    const review =
      wanted === 'latest'
        ? pending[0]
        : /^\d{1,2}$/.test(wanted)
          ? pending[Number(wanted) - 1]
          : pending.find((r) => r.id === wanted);
    if (!review)
      return c.json(
        { error: 'No Developer change like that is waiting.' },
        404,
      );
    try {
      if (action === 'apply')
        return c.json({
          ...(await deps.applyReview(review.id)),
          title: review.title,
        });
      if (action === 'reject')
        return c.json({
          ...(await deps.rejectReview(review.id)),
          title: review.title,
        });
      return c.json({ error: 'Apply or reject.' }, 400);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  app.get('/aj/news', async (c) => {
    const since = Number(c.req.query('since') ?? now() - 3600);
    if (!Number.isFinite(since))
      return c.json({ error: 'since must be unix seconds.' }, 400);
    const found = await deps.python([
      'localtools/aj_report.py',
      'problems',
      String(since),
    ]);
    const state = load();
    const problems = [...((found.problems as unknown[]) ?? [])];
    const finished: unknown[] = [];
    for (const view of state.tasks.map(taskView)) {
      if (!view.updatedAt || view.updatedAt < since) continue;
      if (view.status === 'failed')
        problems.push({
          at: view.updatedAt,
          kind: 'task',
          title: `${view.dot} could not finish a task`,
          message: `${view.task.slice(0, 120)}: ${view.error ?? 'no reason given'}`,
        });
      else if (view.status === 'completed') finished.push(view);
    }
    const last = state.pocket.last;
    if (last?.endedAt && last.endedAt >= since) finished.push(last);
    for (const review of deps.reviews())
      if (review.status === 'pending' && review.createdAt / 1000 >= since)
        finished.push({
          kind: 'review',
          at: review.createdAt / 1000,
          result: `The Developer finished "${review.title}" and it is waiting for your review${review.passed ? '' : '; its checks failed'}.`,
        });
    return c.json({ problems, finished, now: now() });
  });

  app.get('/aj/dots', (c) =>
    c.json({
      dots: deps.dots().map((d) => ({
        id: d.id,
        name: d.name,
        tools: d.toolGroups ?? [],
      })),
    }),
  );

  app.post('/aj/tasks', async (c) => {
    const body = z
      .object({
        dot: z.string().trim().min(1).max(80),
        task: z.string().trim().min(3).max(3500),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: 'Give a Dot and a task of 3 to 3,500 characters.' },
        400,
      );
    const dot = findDot(body.data.dot);
    if (!dot)
      return c.json(
        {
          error: `No Dot called "${body.data.dot}". The Dots are: ${deps
            .dots()
            .map((d) => d.name)
            .join(', ')}.`,
        },
        404,
      );
    if (usesScreen(dot) && load().pocket.current)
      return c.json(
        {
          error: `${dot.name} uses the shared browser, which a Pocket Option run is using now. Stop the run or wait for it to end.`,
        },
        409,
      );
    const thread = await deps.createConversation(
      dot.id,
      `AJ: ${body.data.task.slice(0, 80)}`,
    );
    // The Developer's change is recorded in the vault from its review, so the
    // review has to say plainly what changed and why.
    const note = dot.toolGroups?.includes('developer')
      ? `${DEVELOPER_NOTE} ${TASK_NOTE}`
      : TASK_NOTE;
    const task = deps.store.createTask(`${body.data.task}\n\n${note}`);
    deps.bindTask(task.id, thread.id);
    const state = load();
    const entry = {
      id: task.id,
      dot: dot.name,
      task: body.data.task,
      at: now(),
    };
    state.tasks = [entry, ...state.tasks].slice(0, 100);
    save(state);
    return c.json({ ...entry, conversation: thread.id }, 201);
  });

  app.get('/aj/tasks', (c) =>
    c.json({ tasks: load().tasks.slice(0, 20).map(taskView) }),
  );
  app.get('/aj/tasks/:id', (c) => {
    const entry = load().tasks.find((t) => t.id === c.req.param('id'));
    return entry
      ? c.json(taskView(entry))
      : c.json({ error: 'AJ did not start that task.' }, 404);
  });
  app.post('/aj/tasks/:id/stop', (c) => {
    const entry = load().tasks.find((t) => t.id === c.req.param('id'));
    if (!entry) return c.json({ error: 'AJ did not start that task.' }, 404);
    deps.store.action(entry.id, 'cancel');
    deps.abortTask(entry.id);
    return c.json(taskView(entry));
  });

  app.get('/aj/pocket', async (c) => {
    const state = load();
    const run = state.pocket.current;
    if (!run)
      return c.json({
        active: false,
        last: state.pocket.last ?? null,
        speech: state.pocket.last
          ? pocketSpeech(state.pocket.last, state.pocket.last.endBalance)
          : 'No Pocket Option run has been started yet.',
      });
    const balance = pageBalance(await deps.pageText());
    return c.json({
      active: true,
      run,
      balance: balance ?? null,
      profit: balance === undefined ? null : round(balance - run.start),
      speech: pocketSpeech(run, balance),
    });
  });

  app.post('/aj/pocket', async (c) => {
    const body = z
      .object({
        account: z.enum(['demo', 'real']),
        market: z.enum(['otc', 'real', 'any']),
        goal: z.number().positive().max(100_000),
        lossLimit: z.number().positive().max(100_000),
        minutes: z.number().int().min(5).max(480).default(120),
        confirmRealMoney: z.boolean().default(false),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        {
          error:
            'Name the account (demo or real), the market (otc, real or any), the profit goal and the loss limit in dollars; minutes 5 to 480.',
        },
        400,
      );
    const ask = body.data;
    if (ask.account === 'real' && !ask.confirmRealMoney)
      return c.json(
        {
          error:
            'A real-money run needs confirmRealMoney, sent only after the owner says yes to the account, goal and loss limit read back to them.',
        },
        400,
      );
    const state = load();
    if (state.pocket.current)
      return c.json(
        { error: 'A Pocket Option run is already going; stop it first.' },
        409,
      );
    const busy = busyScreenTask();
    if (busy)
      return c.json(
        {
          error:
            'Another Dot is using the shared browser for a task right now; wait for it to finish.',
        },
        409,
      );
    const url = await deps.pageUrl();
    if (!url || !/pocketoption\.com/.test(url))
      return c.json(
        {
          error:
            "Pocket Option is not open in OpenDots' browser. Open the trading page first.",
        },
        409,
      );
    const text = await deps.pageText();
    const shown = pageAccount(url, text);
    if (shown !== ask.account)
      return c.json(
        {
          error: `You asked for the ${ask.account} account, but the page ${shown ? `shows the ${shown} account` : 'does not show which account it is'}. Switch it on the page yourself, then ask again.`,
        },
        409,
      );
    const balance = pageBalance(text);
    if (balance === undefined)
      return c.json(
        { error: 'The balance on the page could not be read.' },
        409,
      );
    if (ask.lossLimit >= balance)
      return c.json(
        {
          error: `The loss limit (${money(ask.lossLimit)}) is the whole balance (${money(balance)}) or more; choose a smaller one.`,
        },
        400,
      );
    const trader = deps
      .dots()
      .find((d) => d.toolGroups?.includes('trading') && /trader/i.test(d.name));
    if (!trader) return c.json({ error: 'There is no Trader Dot.' }, 409);
    const startedAt = now();
    const run: PocketRun = {
      id: `run-${Math.round(startedAt)}`,
      account: ask.account,
      market: ask.market,
      start: balance,
      target: round(balance + ask.goal),
      stop: round(balance - ask.lossLimit),
      startedAt,
      until: startedAt + ask.minutes * 60,
      conversation: '',
    };
    const thread = await deps.createConversation(
      trader.id,
      `AJ: Pocket Option ${ask.account} run, goal ${money(ask.goal)}`,
    );
    run.conversation = thread.id;
    setRun({
      id: run.id,
      account: run.account,
      market: run.market,
      until: run.until,
    });
    state.pocket.current = run;
    save(state);
    controller = new AbortController();
    stopReason = '';
    const signal = controller.signal;
    // The trade guard refuses trades after `until`; this is the backstop if the
    // model keeps going (a few minutes' grace for a trade still open).
    const backstop = setTimeout(
      () => {
        stopReason = 'time limit reached';
        controller?.abort(new Error(stopReason));
      },
      (ask.minutes + 3) * 60_000,
    );
    const finish = async (how: string, result?: string) => {
      clearTimeout(backstop);
      setRun(undefined);
      const end = pageBalance(await deps.pageText().catch(() => undefined));
      const latest = load();
      latest.pocket.last = {
        ...run,
        endedAt: now(),
        how,
        endBalance: end,
        result: spokenResult(result) ?? undefined,
      };
      delete latest.pocket.current;
      save(latest);
      controller = undefined;
    };
    void deps
      .turn(thread.id, pocketGoal(run), signal)
      .then((text) =>
        finish(
          /goal reached/i.test(text)
            ? 'goal reached'
            : /stop level reached/i.test(text)
              ? 'loss limit reached'
              : /TASK FAILED/i.test(text)
                ? 'the trader could not continue'
                : 'finished',
          text,
        ),
      )
      .catch((error: unknown) =>
        finish(
          stopReason ||
            `failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return c.json({ started: true, run, goal: pocketGoal(run) }, 201);
  });

  app.post('/aj/pocket/stop', (c) => {
    if (!controller || !load().pocket.current)
      return c.json({ error: 'No Pocket Option run is going.' }, 409);
    stopReason = 'stopped by the owner';
    controller.abort(new Error(stopReason));
    return c.json({ stopping: true });
  });

  return app;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** How a run is doing, in a sentence or two for AJ to say. */
export function pocketSpeech(run: PocketRun, balance?: number): string {
  const account = run.account === 'demo' ? 'demo' : 'real money';
  const profit = balance === undefined ? undefined : round(balance - run.start);
  const standing =
    profit === undefined
      ? 'The balance could not be read.'
      : `${profit >= 0 ? 'Up' : 'Down'} ${money(Math.abs(profit))}, at ${money(balance!)}.`;
  if (run.endedAt)
    return `The last Pocket Option run, on the ${account} account, ended: ${run.how}. ${standing}`;
  const left = Math.max(0, Math.round((run.until - Date.now() / 1000) / 60));
  return `The Pocket Option run on the ${account} account is going. ${standing} It stops at ${money(run.target)} or ${money(run.stop)}, or in ${left} minutes.`;
}

/** The real dependencies: OpenDots' platform, store and runner. */
export function ajDeps(
  platform: Platform,
  store: Store,
  runner: Runner,
): AjDeps {
  return {
    store,
    dots: () => platform.workspace.dots(),
    createConversation: (dotId, title) =>
      platform.createConversation(dotId, title),
    bindTask: (taskId, threadId) =>
      platform.workspace.bindTask(taskId, threadId),
    taskThread: (taskId) => platform.workspace.taskThread(taskId),
    threadDot: (threadId) =>
      platform.workspace.conversations().find((t) => t.id === threadId)?.dotId,
    abortTask: (taskId) => runner.abort(taskId),
    turn: (threadId, prompt, signal) => platform.turn(threadId, prompt, signal),
    pageText: () => platform.browser.pageText(),
    pageUrl: async () => (await platform.browser.status()).url,
    python: (args) => runPython(args),
    reviews: () => platform.dev.reviews(),
    applyReview: (id) => platform.dev.apply(id),
    rejectReview: (id) => platform.dev.reject(id),
    stateFile: 'data/aj.json',
    modeFile:
      process.env.LOCALTOOLS_TRADING_MODE_FILE ??
      'localtools/output/trading-mode.json',
  };
}

function runPython(args: string[]): Promise<Record<string, unknown>> {
  const python = existsSync('localtools/.venv/Scripts/python.exe')
    ? 'localtools/.venv/Scripts/python.exe'
    : 'python';
  return new Promise((done) => {
    const child = spawn(python, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', (error) => done({ error: error.message }));
    child.on('close', () => {
      try {
        done(JSON.parse(out) as Record<string, unknown>);
      } catch {
        done({ error: 'The report could not be built.' });
      }
    });
  });
}
