import { ru } from './locales/ru';

export type Locale = 'en' | 'ru';
export type LocalePreference = 'system' | Locale;

const storageKey = 'opendots.locale';
const dictionaries: Record<Locale, Record<string, string>> = { en: {}, ru };

export function localePreference(): LocalePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'en' || value === 'ru' ? value : 'system';
  } catch {
    return 'system';
  }
}

function detect(): Locale {
  const preference = localePreference();
  if (preference !== 'system') return preference;
  const language = typeof navigator === 'undefined' ? '' : navigator.language;
  return language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export const locale: Locale = detect();
if (typeof document !== 'undefined') document.documentElement.lang = locale;

/** The locale is read once at load, so changing it reloads the page. */
export function setLocalePreference(preference: LocalePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    // Without storage the choice cannot persist; keep the current locale.
    return;
  }
  location.reload();
}

function fill(text: string, params?: Record<string, string | number>) {
  return params
    ? text.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
      )
    : text;
}

/** Translate an English source string; unknown strings fall back to English. */
export function t(text: string, params?: Record<string, string | number>) {
  return fill(dictionaries[locale][text] ?? text, params);
}

function russianPlural(count: number) {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return 2;
  if (units === 1) return 0;
  return units >= 2 && units <= 4 ? 1 : 2;
}

/**
 * Count-dependent text. The English source holds `one|other` forms; Russian
 * entries hold three `|`-separated forms (one, few, many).
 */
export function tp(text: string, count: number) {
  const entry = dictionaries[locale][text];
  const forms = (entry ?? text).split('|');
  const index = entry ? russianPlural(count) : count === 1 ? 0 : 1;
  return fill(forms[index] ?? forms[0], { count });
}

export const dateLocale = locale === 'ru' ? 'ru-RU' : undefined;
