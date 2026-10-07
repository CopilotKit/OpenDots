import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
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
    }),
  };
}

const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('snapshots every content edit and restores an earlier version', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, { title: 'Plan', content: 'v1' });
  expect(ws.pages.versions(space, page.id)).toHaveLength(0);

  const second = ws.pages.update(space, page.id, {
    expectedRevision: 1,
    content: 'v2',
  });
  expect(second.revision).toBe(2);
  const third = ws.pages.update(space, page.id, {
    expectedRevision: 2,
    title: 'Plan updated',
    content: 'v3',
  });
  expect(third.revision).toBe(3);

  const versions = ws.pages.versions(space, page.id);
  expect(versions).toHaveLength(2);
  expect(versions[0].revision).toBe(2);
  expect(versions[0].content).toBe('v2');
  expect(versions[1].revision).toBe(1);

  const restored = ws.pages.restoreVersion(space, page.id, {
    versionId: versions[1].id,
    expectedRevision: 3,
  });
  expect(restored).toMatchObject({ title: 'Plan', content: 'v1', revision: 4 });
  expect(ws.pages.versions(space, page.id)).toHaveLength(3);

  expect(() =>
    ws.pages.restoreVersion(space, page.id, {
      versionId: versions[1].id,
      expectedRevision: 3,
    }),
  ).toThrow(/changed/);
  expect(() =>
    ws.pages.restoreVersion(space, page.id, {
      versionId: 'missing',
      expectedRevision: 4,
    }),
  ).toThrow(/not available/);
});

it('bounds history to the newest 50 snapshots', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, { title: 'Log', content: 'v0' });
  let revision = 1;
  for (let i = 1; i <= 55; i += 1) {
    const next = ws.pages.update(space, page.id, {
      expectedRevision: revision,
      content: `v${i}`,
    });
    revision = next.revision;
  }
  const versions = ws.pages.versions(space, page.id);
  expect(versions).toHaveLength(50);
  expect(versions[0].content).toBe('v54');
});

it('soft-deletes into trash, restores, and purges permanently', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  const root = ws.pages.create(space, { title: 'Root' });
  const child = ws.pages.create(space, { title: 'Child', parentId: root.id });

  expect(ws.pages.delete(space, child.id)).toBe(true);
  expect(ws.pages.delete(space, child.id)).toBe(false);
  expect(ws.pages.list(space).map((page) => page.id)).toEqual([root.id]);
  expect(() => ws.pages.get(space, child.id)).toThrow(/not found/);
  expect(ws.pages.exists(space, child.id)).toBe(false);
  expect(ws.pages.trash(space).map((page) => page.id)).toEqual([child.id]);

  const restored = ws.pages.restoreDeleted(space, child.id);
  expect(restored.parentId).toBe(root.id);
  expect(ws.pages.list(space)).toHaveLength(2);
  expect(ws.pages.trash(space)).toHaveLength(0);

  expect(ws.pages.delete(space, child.id)).toBe(true);
  expect(ws.pages.purge(space, child.id)).toBe(true);
  expect(ws.pages.purge(space, child.id)).toBe(false);
  expect(ws.pages.trash(space)).toHaveLength(0);
  expect(ws.pages.versions(space, root.id)).toHaveLength(0);
});

it('reparents children on soft-delete and restores trash under a live parent', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  const root = ws.pages.create(space, { title: 'Root' });
  const child = ws.pages.create(space, { title: 'Child', parentId: root.id });
  const grandChild = ws.pages.create(space, {
    title: 'Grandchild',
    parentId: child.id,
  });

  ws.pages.delete(space, child.id);
  expect(ws.pages.get(space, grandChild.id).parentId).toBe(root.id);

  const restored = ws.pages.restoreDeleted(space, child.id);
  expect(restored.parentId).toBe(root.id);
  // Restored pages reappear alongside, not by stealing reparented children back.
  expect(ws.pages.get(space, grandChild.id).parentId).toBe(root.id);
});

it('exports a space and reimports it with hierarchy remapped', () => {
  const { ws } = fixture();
  const space = ws.spaces()[0].id;
  const parent = ws.pages.create(space, { title: 'Parent', content: 'p' });
  ws.pages.create(space, {
    title: 'Child',
    content: 'c',
    parentId: parent.id,
  });

  const exported = ws.pages.exportSpace(space);
  expect(exported.pages).toHaveLength(2);

  const other = ws.createSpace('Imported', '').id;
  const imported = ws.pages.importSpace(other, {
    pages: exported.pages.map((page) => ({
      id: page.id,
      title: page.title,
      content: page.content,
      parentId: page.parentId,
    })),
  });
  expect(imported).toHaveLength(2);
  const importedParent = imported.find((page) => page.title === 'Parent')!;
  const importedChild = imported.find((page) => page.title === 'Child')!;
  expect(importedChild.parentId).toBe(importedParent.id);
  expect(importedParent.id).not.toBe(parent.id);

  expect(() => ws.pages.importSpace(other, { pages: [] })).toThrow();
});

it('serves history, trash, export, and import over the owner API', async () => {
  const { ws, app } = fixture();
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, { title: 'Doc', content: 'one' });
  ws.pages.update(space, page.id, { expectedRevision: 1, content: 'two' });

  const versions = await (
    await app.request(`/api/spaces/${space}/pages/${page.id}/versions`)
  ).json();
  expect(versions).toHaveLength(1);

  const badRestore = await app.request(
    `/api/spaces/${space}/pages/${page.id}/restore`,
    request({ versionId: versions[0].id, expectedRevision: 1 }),
  );
  expect(badRestore.status).toBe(409);

  const goodRestore = await app.request(
    `/api/spaces/${space}/pages/${page.id}/restore`,
    request({ versionId: versions[0].id, expectedRevision: 2 }),
  );
  expect(goodRestore.status).toBe(200);
  expect(await goodRestore.json()).toMatchObject({ content: 'one' });

  const deleted = await app.request(
    `/api/spaces/${space}/pages/${page.id}`,
    request(undefined, 'DELETE'),
  );
  expect(deleted.status).toBe(200);
  const trash = await (await app.request(`/api/spaces/${space}/trash`)).json();
  expect(trash.map((entry: { id: string }) => entry.id)).toEqual([page.id]);

  const restored = await app.request(
    `/api/spaces/${space}/trash/${page.id}/restore`,
    request(undefined),
  );
  expect(restored.status).toBe(200);

  const exported = await (
    await app.request(`/api/spaces/${space}/export`)
  ).json();
  expect(exported.pages.length).toBeGreaterThan(0);

  const badImport = await app.request(
    `/api/spaces/${space}/import`,
    request({ pages: [] }),
  );
  expect(badImport.status).toBe(400);
  const imported = await app.request(
    `/api/spaces/${space}/import`,
    request({ pages: [{ title: 'Copy', content: 'text' }] }),
  );
  expect(imported.status).toBe(201);

  await app.request(
    `/api/spaces/${space}/pages/${page.id}`,
    request(undefined, 'DELETE'),
  );
  const purged = await app.request(
    `/api/spaces/${space}/trash/${page.id}`,
    request(undefined, 'DELETE'),
  );
  expect(purged.status).toBe(200);
  expect((await app.request(`/api/spaces/${space}/trash`)).status).toBe(200);
});
