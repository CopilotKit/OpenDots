import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const bootstrap = readFileSync('public/theme-bootstrap.js', 'utf8');
function load({ saved, dark = false, denied = false } = {}) {
  const root = { dataset: {}, style: {} };
  const window = {
    get localStorage() {
      if (denied)
        throw new globalThis.DOMException('Storage denied', 'SecurityError');
      return { getItem: () => saved ?? null };
    },
    matchMedia: () => ({ matches: dark }),
  };
  runInNewContext(bootstrap, { window, document: { documentElement: root } });
  return { root, resolver: window.openDotsTheme };
}

describe('the blocking theme resolver', () => {
  it('honors each saved palette before React loads', () => {
    for (const saved of ['meadow', 'redwood', 'coastal', 'canyon', 'alpine']) {
      const { root, resolver } = load({ saved, dark: saved !== 'alpine' });
      expect(root.dataset.theme).toBe(saved);
      expect(resolver.read()).toBe(saved);
      expect(root.style.colorScheme).toBe(
        saved === 'alpine' ? 'dark' : 'light',
      );
    }
  });
  it('rejects corrupt preferences and uses the system color scheme', () => {
    for (const saved of [undefined, '', 'invalid', '__proto__']) {
      expect(load({ saved, dark: true }).root.dataset.theme).toBe('alpine');
      expect(load({ saved }).root.dataset.theme).toBe('meadow');
    }
  });
  it('survives denied storage access and keeps prepaint and React resolution equal', () => {
    const { root, resolver } = load({ denied: true, dark: true });
    expect(root.dataset.theme).toBe('alpine');
    expect(resolver.read()).toBe('alpine');
    resolver.apply('coastal');
    expect(root.dataset.theme).toBe('coastal');
    expect(root.style.colorScheme).toBe('light');
  });
  it('runs a same-origin classic script before the app entry and any stylesheet', () => {
    const html = readFileSync('index.html', 'utf8');
    const start = html.indexOf('<script src="/theme-bootstrap.js"></script>');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(html.indexOf('</head>'));
    expect(start).toBeLessThan(html.indexOf('src="/src/client/main.tsx"'));
    expect(html.slice(0, start)).not.toMatch(/rel="stylesheet"/);
  });
});
