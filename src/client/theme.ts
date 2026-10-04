export type ThemePreference = 'system' | 'light' | 'dark';
const key = 'opendots-theme';
const query = () => window.matchMedia('(prefers-color-scheme: dark)');
// Storage can be unavailable (private windows, blocked site data); the theme
// then follows the system for this visit.
export function themePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(key);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Fall through to the system theme.
  }
  return 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
function apply() {
  const theme = resolveTheme(themePreference(), query().matches);
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#1b1b1b' : '#f8f7f4');
}
export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, preference);
  } catch {
    // Applies for this visit only.
  }
  apply();
}
export function watchSystemTheme() {
  apply();
  query().addEventListener('change', apply);
}
