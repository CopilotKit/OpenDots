import { useCallback, useEffect, useState } from 'react';

export type ThemeId = 'meadow' | 'redwood' | 'coastal' | 'canyon' | 'alpine';

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  blurb: string;
  dark?: boolean;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'meadow',
    name: 'Meadow Light',
    blurb: 'The familiar OpenDots morning.',
  },
  { id: 'redwood', name: 'Redwood Grove', blurb: 'Deep forest, warm bark.' },
  { id: 'coastal', name: 'Coastal Fog', blurb: 'Ocean mist, muted blue-grey.' },
  { id: 'canyon', name: 'Canyon Bloom', blurb: 'Desert dusk, terracotta.' },
  {
    id: 'alpine',
    name: 'Moonlit Alpine',
    blurb: 'Night pines. Dark only.',
    dark: true,
  },
];

const STORAGE_KEY = 'opendots-theme';

declare global {
  interface Window {
    openDotsTheme: {
      read(): ThemeId;
      isTheme(value: unknown): value is ThemeId;
      apply(theme: ThemeId): void;
    };
  }
}

export function isTheme(value: unknown): value is ThemeId {
  return window.openDotsTheme.isTheme(value);
}

function initialTheme(): ThemeId {
  if (typeof window === 'undefined') return 'meadow';
  return window.openDotsTheme.read();
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(() => initialTheme());
  useEffect(() => {
    window.openDotsTheme.apply(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private-mode storage failures must not break the app.
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }, [theme]);
  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
  }, []);
  return { theme, setTheme };
}
