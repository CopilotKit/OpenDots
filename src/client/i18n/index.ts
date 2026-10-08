import { useSyncExternalStore } from 'react';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { ptBR } from './pt-BR';

export type Language = 'pt-BR' | 'en' | 'es' | 'fr';
type TranslationPath = {
  [
    Group in keyof typeof ptBR
  ]: `${Group}.${Extract<keyof (typeof ptBR)[Group], string>}`;
}[keyof typeof ptBR];

const storageKey = 'opendots-language';
const changeEvent = 'opendots-language-change';

export function languagePreference(): Language {
  try {
    const language = localStorage.getItem(storageKey);
    return language === 'en' || language === 'es' || language === 'fr'
      ? language
      : 'pt-BR';
  } catch {
    return 'pt-BR';
  }
}

export function setLanguage(language: Language) {
  try {
    localStorage.setItem(storageKey, language);
  } catch {
    // Keep the current page usable when browser storage is unavailable.
  }
  document.documentElement.lang = language;
  window.dispatchEvent(new Event(changeEvent));
}

export function useLanguage() {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener(changeEvent, callback);
      return () => window.removeEventListener(changeEvent, callback);
    },
    languagePreference,
    () => 'pt-BR',
  );
}

export function t(key: TranslationPath): string {
  const [group, item] = key.split('.') as [keyof typeof ptBR, string];
  const dictionary = { 'pt-BR': ptBR, en, es, fr }[languagePreference()];
  return (dictionary[group] as Record<string, string>)[item];
}

export function localizedStarterSpaceName(name: string) {
  return name === 'Everyday' || name === 'Espaço do dia a dia'
    ? t('starter.spaceName')
    : name;
}

export function localizedStarterSpaceDescription(description: string) {
  return description === 'A little space for your day.' ||
    description === 'Um espaço para organizar seu dia.'
    ? t('starter.spaceDescription')
    : description;
}

export function localizedSlackStatus(status: string) {
  const key = {
    online: 'dialogs.slackOnline',
    activation_failed: 'dialogs.slackActivationFailed',
    setup_required: 'dialogs.slackSetupRequired',
    not_configured: 'dialogs.slackNotConfigured',
  }[status] as TranslationPath | undefined;
  return key ? t(key) : status.replaceAll('_', ' ');
}

export function localizeMissingSetting(name: string) {
  return name.replace(' (or ', ` (${t('dialogs.or')} `);
}

document.documentElement.lang = languagePreference();
