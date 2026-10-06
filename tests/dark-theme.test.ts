import { expect, it, vi } from 'vitest';
import postcss from 'postcss';
import {
  contrast,
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
it('keeps fixed surfaces in their light colors, untouched by global rules', () => {
  const css = run(`
    button:focus-visible { outline: 3px solid #b8c4fa; }
    input::placeholder { color: #999; }
    .row:not(:last-child):before { background: #eee; }
    ::-webkit-scrollbar-thumb:hover { background: #ccc; }
    /* theme: fixed .call-view */
    .call-view { background: #1c544c; }
    .call-view button { color: #fff; }
    /* theme: end */
    .after { color: #000; }
    @keyframes glow { from { color: #fff; } }
    .logo { background: url(/dot.png); }
  `);
  // Nothing is generated for the fixed surface itself...
  expect(css).not.toMatch(/dark'\] \.call-view \{/);
  // ...and generated global rules skip it, so a keyboard focus ring inside
  // keeps its light color (the reviewer's #373e64 regression).
  expect(css).toContain(
    ":root[data-theme='dark'] button:focus-visible:not(.call-view, .call-view *) { outline: 3px solid #",
  );
  expect(css).toContain(
    ":root[data-theme='dark'] input:not(.call-view, .call-view *)::placeholder",
  );
  expect(css).toContain(
    ":root[data-theme='dark'] .after:not(.call-view, .call-view *) { color: #eeeeee; }",
  );
  expect(css).toContain(
    ":root[data-theme='dark'] .row:not(:last-child):not(.call-view, .call-view *):before",
  );
  expect(css).toContain(
    ":root[data-theme='dark'] :not(.call-view, .call-view *)::-webkit-scrollbar-thumb:hover",
  );
  // A pseudo-element cannot be followed by :not() (the minifier rejects it).
  expect(css).not.toMatch(
    /(::[\w-]+|:(before|after|first-line|first-letter))[^,{]*:not\(\.call-view/,
  );
  expect(css).not.toMatch(/dark'\] from/);
  expect(css).not.toContain("'dark'] .logo");
});
it('resolves the system preference', () => {
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('dark', false)).toBe('dark');
});

const declared = (css: string, selector: string, prop: string) =>
  css.match(
    new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*?${prop}: (#[0-9a-f]{6})`,
    ),
  )?.[1];
it('keeps text readable on its own, without the separate polish layer', () => {
  // The Settings service-setup note: text and surface come from two rules.
  const note = run(`
    .config-note { background: #f5f4f8; }
    .config-note p { color: #a2a0ad; }
  `);
  const surface = declared(note, "'dark'] .config-note", 'background')!;
  const text = declared(note, "'dark'] .config-note p", 'color')!;
  expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
  // Any text color stays readable on the darkest and lightest dark surfaces.
  for (const light of ['#ffffff', '#f8f7f4', '#e9e8e6'])
    for (const ink of ['#a2a0ad', '#c7cee9', '#b0b0b7', '#999eaa']) {
      const css = run(`.a { color: ${ink}; }`);
      expect(
        contrast(declared(css, "'dark'] .a", 'color')!, darkColor(light)),
      ).toBeGreaterThanOrEqual(4.5);
    }
});
it("keeps a rule's own text and background pair at AA", () => {
  // The enabled Save button: mid-tone lavender with white text.
  for (const background of ['#7689d3', '#8292d6', '#496d61', '#c4473a']) {
    const css = run(`.primary { background: ${background}; color: white; }`);
    const fill = declared(css, "'dark'] .primary", 'background')!;
    const text = declared(css, "'dark'] .primary", 'color')!;
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
  }
});
it('applies the chosen theme even when storage is unavailable', async () => {
  const dataset: Record<string, string> = {};
  const listeners: (() => void)[] = [];
  const failing = () => {
    throw new Error('SecurityError');
  };
  vi.stubGlobal('localStorage', {
    getItem: failing,
    setItem: failing,
    removeItem: failing,
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({
      matches: false,
      addEventListener: (_: string, listener: () => void) =>
        listeners.push(listener),
    }),
  });
  vi.stubGlobal('document', {
    documentElement: { dataset },
    querySelector: () => null,
  });
  try {
    vi.resetModules();
    const theme = await import('../src/client/theme');
    theme.watchSystemTheme();
    expect(dataset.theme).toBe('light');
    theme.setThemePreference('dark');
    expect(dataset.theme).toBe('dark');
    expect(theme.themePreference()).toBe('dark');
    // A system change does not undo the choice for this page.
    listeners.forEach((listener) => listener());
    expect(dataset.theme).toBe('dark');
  } finally {
    vi.unstubAllGlobals();
  }
});
it('checks text against a variable background in the same rule', () => {
  // Current main: the enabled Save button is background: var(--accent).
  const css = run(`
    .template-app { --accent: #242424; }
    .template-app .primary { background: var(--accent); color: #fff; }
  `);
  const text = declared(css, "'dark'] .template-app .primary", 'color')!;
  // The variable keeps its own dark mapping; the text is chosen for it.
  expect(css).toMatch(
    /\.template-app \.primary \{ background: var\(--accent\);/,
  );
  expect(contrast(text, darkColor('#242424'))).toBeGreaterThanOrEqual(4.5);
});
