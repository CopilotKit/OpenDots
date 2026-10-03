import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
  };
  // No computer supervisor configured: `configured` is false, so any
  // action that reaches `allowed()` fails with a plain domain error
  // rather than attempting a network call.
  const service = new ComputerService(workspace, config, () => false);
  const app = computerRoutes(service);
  return { workspace, id, app };
}

it('answers malformed JSON on the actions route with 400, not a service error', async () => {
  const { app, id } = fixture();
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid JSON request.' });
});

it('answers an invalid action shape with 400 from the Zod schema', async () => {
  const { app, id } = fixture();
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid computer request.' });
});

it('answers an unconfigured computer service with 503, not 400', async () => {
  const { app, id } = fixture();
  const response = await app.request(`/dots/${id}/computer/start`, {
    method: 'POST',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Computer service is not configured.',
  });
});

it('answers an unknown Dot id with 503, carrying the domain error message', async () => {
  const { app } = fixture();
  const response = await app.request('/dots/missing/computer/start', {
    method: 'POST',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Dot not found.' });
});
