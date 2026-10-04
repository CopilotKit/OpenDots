import { expect, it } from 'vitest';
import postcss from 'postcss';
import {
  darkColor,
  darkSelector,
  darkTheme,
  darkValue,
} from '../src/build/dark-theme';
import { resolveTheme } from '../src/client/theme';
const run = (css: string) =>
  postcss([darkTheme()]).process(css, { from: undefined }).css;
const lightness = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r + g + b) / 3;
};
it('flips lightness, keeps hue, and preserves alpha', () => {
  expect(darkColor('#ffffff')).toBe('#1b1b1b');
  expect(darkColor('#000000')).toBe('#eeeeee');
  expect(darkColor('#fff')).toBe('#1b1b1b');
  expect(lightness(darkColor('#f4f4f4'))).toBeLessThan(40);
  const green = darkColor('#496d61');
  expect(parseInt(green.slice(3, 5), 16)).toBeGreaterThan(
    parseInt(green.slice(1, 3), 16),
  );
  expect(darkColor('#ffffff80')).toBe('#1b1b1b80');
});
it('keeps shadows dark instead of turning them into glows', () => {
  expect(darkValue('box-shadow', '0 1px 2px #20263418')).toMatch(
    /^0 1px 2px #000000[0-9a-f]{2}$/,
  );
  expect(darkValue('border', '1px solid white')).toBe('1px solid #1b1b1b');
});
it('scopes selectors to the dark theme attribute', () => {
  expect(darkSelector('.a, .b:hover')).toBe(
    ":root[data-theme='dark'] .a, :root[data-theme='dark'] .b:hover",
  );
  expect(darkSelector(':root')).toBe(":root[data-theme='dark']");
  expect(darkSelector('html body')).toBe("html[data-theme='dark'] body");
});
it('twins only color declarations, inside the same media query', () => {
  const css = run(`
    .card { padding: 4px; color: #333; border-radius: 8px; }
    @media (max-width: 700px) { .card { background: #fff; margin: 0; } }
  `);
  expect(css).toContain(":root[data-theme='dark'] .card { color: #");
  expect(css).not.toMatch(/data-theme='dark'\] \.card \{[^}]*padding/);
  expect(css).toMatch(
    /@media \(max-width: 700px\) \{[^@]*:root\[data-theme='dark'\] \.card \{ background: #1b1b1b; \}/,
  );
});
it('keeps the light cascade order when later rules have no literal color', () => {
  const css = run(`
    button { background: #fff; }
    .icon-button { background: none; }
    .primary { background: var(--accent); }
  `);
  // Without these twins, button's dark rule would beat .icon-button.
  expect(css).toContain(
    ":root[data-theme='dark'] .icon-button { background: none; }",
  );
  expect(css).toContain(
    ":root[data-theme='dark'] .primary { background: var(--accent); }",
  );
});
it('leaves fixed surfaces, keyframes, and images alone', () => {
  const css = run(`
    /* theme: fixed */
    .call-view { background: #1c544c; }
    /* theme: end */
    .after { color: #000; }
    @keyframes glow { from { color: #fff; } }
    .logo { background: url(/dot.png); }
  `);
  expect(css).not.toContain("'dark'] .call-view");
  expect(css).toContain(":root[data-theme='dark'] .after { color: #eeeeee; }");
  expect(css).not.toMatch(/dark'\] from/);
  expect(css).not.toContain("'dark'] .logo");
});
it('resolves the system preference', () => {
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('dark', false)).toBe('dark');
});
