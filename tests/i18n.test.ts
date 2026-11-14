import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(language: string, stored?: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { language });
  vi.stubGlobal('localStorage', {
    getItem: () => stored ?? null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  return import('../src/client/i18n');
}

afterEach(() => vi.unstubAllGlobals());

describe('i18n', () => {
  it('keeps English source text outside Russian locales', async () => {
    const { t, tp, locale } = await load('en-US');
    expect(locale).toBe('en');
    expect(t('Message {name}…', { name: 'Scout' })).toBe('Message Scout…');
    expect(tp('{count} page|{count} pages', 1)).toBe('1 page');
    expect(tp('{count} page|{count} pages', 2)).toBe('2 pages');
  });

  it('translates to Russian for a Russian browser and falls back to English', async () => {
    const { t, tp, locale } = await load('ru-RU');
    expect(locale).toBe('ru');
    expect(t('New chat')).toBe('Новый чат');
    expect(t('Message {name}…', { name: 'Scout' })).toBe(
      'Сообщение для Scout…',
    );
    expect(t('A string without a translation')).toBe(
      'A string without a translation',
    );
    const pages = 'Pages: {count} page|{count} pages';
    expect(tp(pages, 3)).toBe('3 pages');
    expect(tp('{count} page|{count} pages', 1)).toBe('1 страница');
    expect(tp('{count} page|{count} pages', 3)).toBe('3 страницы');
    expect(tp('{count} page|{count} pages', 5)).toBe('5 страниц');
    expect(tp('{count} page|{count} pages', 11)).toBe('11 страниц');
    expect(tp('{count} page|{count} pages', 21)).toBe('21 страница');
  });

  it('lets a saved preference override the browser language', async () => {
    expect((await load('ru-RU', 'en')).locale).toBe('en');
    expect((await load('en-US', 'ru')).locale).toBe('ru');
  });

  it('keeps placeholders identical in every Russian entry', async () => {
    const { ru } = await import('../src/client/locales/ru');
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
    for (const [source, translation] of Object.entries(ru))
      for (const placeholder of new Set(placeholders(source)))
        expect(translation, source).toContain(placeholder);
  });
});
