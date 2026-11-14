import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  excerpt,
  scoreText,
  searchWorkspace,
  tokenize,
} from '../src/server/search.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture(ownerToken?: string) {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  return {
    ws,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
      ownerToken,
    }),
  };
}

it('tokenizes queries into bounded lowercase terms', () => {
  expect(tokenize('  Plan for Q3! ')).toEqual(['plan', 'for', 'q3']);
  expect(tokenize('a b c')).toEqual([]);
  expect(tokenize('one two three four five six seven eight nine')).toHaveLength(
    8,
  );
});

it('prefers title and prefix matches over body matches', () => {
  const tokens = ['plan'];
  const title = scoreText('Plan quarterly review', 'other words here', tokens);
  const body = scoreText('Something else', 'a long plan document', tokens);
  expect(title.score).toBeGreaterThan(body.score);
  expect(scoreText('Unrelated', 'nothing here', tokens).matched).toBe(0);
});

it('builds a bounded excerpt around the first match', () => {
  expect(excerpt('', ['plan'])).toBe('');
  const content = `Intro words. The plan continues with details. ${'x '.repeat(200)}`;
  const cut = excerpt(content, ['plan'], 60);
  expect(cut.length).toBeLessThanOrEqual(66);
  expect(cut.toLocaleLowerCase()).toContain('plan');
});

it('ranks pages, spaces, and dots across the whole workspace', () => {
  const { ws } = fixture();
  const first = ws.spaces()[0].id;
  const second = ws.createSpace('Launch planning', 'Release notes').id;
  ws.pages.create(first, { title: 'Grocery list', content: 'milk eggs' });
  const target = ws.pages.create(second, {
    title: 'Launch plan',
    content: 'The launch plan covers rollout steps.',
  });

  const results = searchWorkspace(ws, 'launch plan', 20);
  expect(results.pages[0].id).toBe(target.id);
  expect(results.pages[0].spaceName).toBe('Launch planning');
  expect(results.pages[0].excerpt.toLocaleLowerCase()).toContain('launch');
  expect(results.spaces.map((space) => space.id)).toContain(second);
  expect(results.query).toBe('launch plan');
});

it('requires enough token overlap for multi-word queries', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  ws.pages.create(space, { title: 'Cats', content: 'cats cats cats' });
  expect(searchWorkspace(ws, 'cats dogs birds fish', 20).pages).toHaveLength(0);
});

it('serves search over the owner API with validation and limits', async () => {
  const { ws, app } = fixture();
  const space = ws.spaces()[0].id;
  ws.pages.create(space, { title: 'Alpha page', content: 'alpha content' });
  ws.pages.create(space, { title: 'Beta page', content: 'beta content' });

  expect((await app.request('/api/search')).status).toBe(400);
  expect((await app.request('/api/search?q=a')).status).toBe(400);
  const ok = await app.request('/api/search?q=alpha&limit=5');
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.pages.map((page: { title: string }) => page.title)).toEqual([
    'Alpha page',
  ]);
  expect(body.pages[0].excerpt.length).toBeLessThanOrEqual(166);

  const capped = await app.request('/api/search?q=page&limit=500');
  expect(capped.status).toBe(400);
});

it('keeps search behind owner authentication', async () => {
  const { app } = fixture('owner-secret');
  expect((await app.request('/api/search?q=alpha')).status).toBe(401);
  expect(
    (
      await app.request('/api/search?q=alpha', {
        headers: { Authorization: 'Bearer owner-secret' },
      })
    ).status,
  ).toBe(200);
});
