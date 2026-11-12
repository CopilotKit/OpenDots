// Applies the saved theme before the first paint so dark mode never flashes
// white. Kept in sync with src/client/theme.ts, which handles later changes.
(function () {
  var preference = 'system';
  try {
    preference = localStorage.getItem('opendots-theme') || 'system';
  } catch (error) {}
  var dark =
    preference === 'dark' ||
    (preference !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
