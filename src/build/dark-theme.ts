import type { AtRule, Declaration, Plugin, Rule } from 'postcss';
// Build-time dark theme. Every rule with colors gets a sibling rule under
// :root[data-theme='dark'] with only its color declarations, mapped by
// flipping perceptual (OKLab) lightness and keeping hue. New styles get a
// dark variant automatically, and cascade order is preserved because every
// dark rule gains the same specificity and sits right after its original.
// Wrap intentionally dark surfaces in /* theme: fixed */ ... /* theme: end */.
export const DARK = ":root[data-theme='dark']";
const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function rgbToOklab([r, g, b]: number[]) {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToRgb([L, a, b]: number[]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, toSrgb(c))));
}
function parseHex(hex: string) {
  let value = hex.slice(1);
  if (value.length <= 4) value = [...value].map((char) => char + char).join('');
  const channels = value.match(/../g)!.map((pair) => parseInt(pair, 16) / 255);
  return { rgb: channels.slice(0, 3), alpha: channels[3] };
}
const hex = (rgb: number[], alpha?: number) =>
  '#' +
  [...rgb, ...(alpha === undefined ? [] : [alpha])]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
// White maps to #1b1b1b, black to #eeeeee. The exponent lifts mid-tones so
// secondary text keeps AA contrast on the dark canvas.
export function darkColor(value: string) {
  const { rgb, alpha } = parseHex(value);
  const [L, a, b] = rgbToOklab(rgb);
  const next = 0.95 - 0.73 * L ** 1.3;
  return hex(oklabToRgb([next, a * 0.85, b * 0.85]), alpha);
}
const named: Record<string, string> = { white: '#ffffff', black: '#000000' };
const colorToken = /#[0-9a-fA-F]{3,8}\b|\b(?:white|black)\b/g;
export function darkValue(prop: string, value: string) {
  // Shadows stay shadows: keep their alpha, drop their tint.
  const shadow = /shadow/.test(prop) || value.includes('drop-shadow(');
  return value.replace(colorToken, (token) => {
    const color = named[token] ?? token;
    if (!shadow) return darkColor(color);
    const { alpha } = parseHex(color);
    return hex([0, 0, 0], Math.min(1, (alpha ?? 0.35) * 1.6));
  });
}
const colorProp =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|fill|stroke|accent-color|caret-color|text-decoration(-color)?|box-shadow|text-shadow)$/;
// Every declaration of a color property gets a twin, even `none` or
// `var(--x)`: otherwise a later light rule without a literal color would
// lose to an earlier rule's dark twin and the cascade would invert.
const themed = (decl: Declaration) =>
  !decl.value.includes('url(') &&
  (new RegExp(colorToken.source).test(decl.value) ||
    (colorProp.test(decl.prop) && !decl.prop.startsWith('--')));
export function darkSelector(selector: string) {
  return selector
    .split(',')
    .map((part) => {
      const item = part.trim();
      if (item.startsWith(':root')) return DARK + item.slice(5);
      if (/^html\b/.test(item))
        return `html[data-theme='dark']${item.slice(4)}`;
      return `${DARK} ${item}`;
    })
    .join(', ');
}
export function darkTheme(): Plugin {
  return {
    postcssPlugin: 'opendots-dark-theme',
    Once(root) {
      let fixed = false;
      const rules: Rule[] = [];
      root.each(function visit(node): void {
        if (node.type === 'comment') {
          if (/^\s*theme:\s*fixed\s*$/.test(node.text)) fixed = true;
          if (/^\s*theme:\s*end\s*$/.test(node.text)) fixed = false;
          return;
        }
        if (fixed) return;
        if (node.type === 'atrule') {
          // Animations interpolate their own colors; leave them alone.
          if (!/keyframes$/.test((node as AtRule).name))
            (node as AtRule).each(visit);
          return;
        }
        if (node.type === 'rule' && !node.selector.startsWith(DARK))
          rules.push(node);
      });
      for (const rule of rules) {
        const colors = rule.nodes.filter(
          (node): node is Declaration => node.type === 'decl' && themed(node),
        );
        if (!colors.length) continue;
        const dark = rule.clone({ selector: darkSelector(rule.selector) });
        dark.removeAll();
        for (const decl of colors)
          dark.append(decl.clone({ value: darkValue(decl.prop, decl.value) }));
        rule.after(dark);
      }
    },
  };
}
darkTheme.postcss = true;
