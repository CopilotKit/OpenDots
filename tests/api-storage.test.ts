import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('retains an authentication token when the storage getter and writes fail', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage',
  );
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
  });
  try {
    const { setToken, authHeaders, api } = await import('../src/client/api.js');
    expect(authHeaders()).toEqual({});
    setToken('fixture-owner-token');
    expect(authHeaders()).toEqual({
      Authorization: 'Bearer fixture-owner-token',
    });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));
    await api('/settings');
    expect(
      new Headers(network.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-owner-token');
    setToken('');
    expect(authHeaders()).toEqual({});
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

it('loads and persists the owner token when session storage is available', async () => {
  const storage = {
    getItem: vi.fn(() => 'fixture-saved-token'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  vi.stubGlobal('sessionStorage', storage);
  const { setToken, authHeaders } = await import('../src/client/api.js');
  expect(authHeaders()).toEqual({
    Authorization: 'Bearer fixture-saved-token',
  });
  setToken('fixture-new-token');
  expect(storage.setItem).toHaveBeenCalledWith(
    'opendots-token',
    'fixture-new-token',
  );
  setToken('');
  expect(storage.removeItem).toHaveBeenCalledWith('opendots-token');
});
