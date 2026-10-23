import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { VaultView } from '../src/client/VaultView';
import { desktopApi, type PloopDesktopApi } from '../src/client/desktop';

const api = {
  vault: {
    list: vi.fn(async () => []),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reveal: vi.fn(),
    copyPassword: vi.fn(),
    signIn: vi.fn(),
  },
  settings: { status: vi.fn(), save: vi.fn() },
  app: { info: vi.fn(), checkForUpdates: vi.fn() },
} as unknown as PloopDesktopApi;

it('shows the logins and about sections of the Mac app', () => {
  const html = renderToStaticMarkup(<VaultView api={api} />);
  expect(html).toContain('<h1>Vault</h1>');
  expect(html).toContain('Logins');
  expect(html).toContain('About');
});

it('has no vault outside the Mac app', () => {
  expect(desktopApi()).toBeUndefined();
});
