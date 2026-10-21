// Coming back to OpenDots after a dropped connection (a phone over Tailscale
// losing signal or putting the page to sleep) left the chat frozen: the run
// kept going on the PC but this page had lost its event stream. Reloading
// reconnects to the chat and replays what happened meanwhile.

/** Background time after which a phone page reloads on return. */
export const AWAY_MS = 20_000;

export function shouldReload({
  hiddenFor,
  wentOffline,
  touch,
}: {
  hiddenFor: number;
  wentOffline: boolean;
  touch: boolean;
}) {
  // A dropped connection always; on phones also a long spell in the
  // background, where the browser suspends the page and its stream.
  return wentOffline || (touch && hiddenFor >= AWAY_MS);
}

export function installReconnect(
  win: Window = window,
  reload: () => void = () => win.location.reload(),
) {
  const doc = win.document;
  const touch = win.matchMedia?.('(pointer: coarse)').matches ?? false;
  let hiddenAt = doc.visibilityState === 'hidden' ? Date.now() : 0;
  let wentOffline = false;
  const check = () => {
    if (doc.visibilityState !== 'visible' || !win.navigator.onLine) return;
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (shouldReload({ hiddenFor, wentOffline, touch })) reload();
    wentOffline = false;
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') hiddenAt ||= Date.now();
    else check();
  };
  const onOffline = () => {
    wentOffline = true;
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('offline', onOffline);
  win.addEventListener('online', check);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('offline', onOffline);
    win.removeEventListener('online', check);
  };
}
