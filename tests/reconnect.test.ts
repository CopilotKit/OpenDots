import { expect, it } from 'vitest';
import {
  AWAY_MS,
  installReconnect,
  shouldReload,
} from '../src/client/reconnect';

it('reloads after a dropped connection, or a long background spell on a phone', () => {
  expect(shouldReload({ hiddenFor: 0, wentOffline: true, touch: false })).toBe(
    true,
  );
  expect(
    shouldReload({ hiddenFor: AWAY_MS, wentOffline: false, touch: true }),
  ).toBe(true);
  expect(
    shouldReload({ hiddenFor: 5_000, wentOffline: false, touch: true }),
  ).toBe(false);
  // Switching tabs on the desktop leaves the page alone.
  expect(
    shouldReload({ hiddenFor: 60_000, wentOffline: false, touch: false }),
  ).toBe(false);
});

it('reloads when the connection comes back after going offline', () => {
  const listeners = new Map<string, () => void>();
  const target = (name: string, fn: () => void) => listeners.set(name, fn);
  const doc = {
    visibilityState: 'visible',
    addEventListener: target,
    removeEventListener: () => {},
  };
  const win = {
    document: doc,
    navigator: { onLine: true },
    matchMedia: () => ({ matches: false }),
    addEventListener: target,
    removeEventListener: () => {},
  } as unknown as Window;
  let reloads = 0;
  installReconnect(win, () => reloads++);
  listeners.get('online')!();
  expect(reloads).toBe(0); // Online without having gone offline: nothing to do.
  listeners.get('offline')!();
  listeners.get('online')!();
  expect(reloads).toBe(1);
});
