import { afterEach, beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

// CopilotKitProvider refetches inspector metadata whenever its headers prop is
// a new object, and App re-renders on every 3 s poll.
it('returns the same auth headers object until the token changes', async () => {
  const { authHeaders, setToken } = await import('../src/client/api');
  expect(authHeaders()).toEqual({});
  expect(authHeaders()).toBe(authHeaders());
  setToken('secret');
  const headers = authHeaders();
  expect(headers).toEqual({ Authorization: 'Bearer secret' });
  expect(authHeaders()).toBe(headers);
  setToken('');
  expect(authHeaders()).toEqual({});
});
