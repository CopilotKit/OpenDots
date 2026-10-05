// A blocking, same-origin script selects the palette before styles can paint.
// React uses this same resolver so invalid preferences and denied storage agree.
(function () {
  const ids = ['meadow', 'redwood', 'coastal', 'canyon', 'alpine'];
  const key = 'opendots-theme';
  const isTheme = (value) => ids.includes(value);
  function read() {
    try {
      const saved = window.localStorage.getItem(key);
      if (isTheme(saved)) return saved;
    } catch {
      // Storage can be denied by the browser; the system preference still works.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'alpine'
      : 'meadow';
  }
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme =
      theme === 'alpine' ? 'dark' : 'light';
  }
  window.openDotsTheme = { read, isTheme, apply };
  apply(read());
})();
