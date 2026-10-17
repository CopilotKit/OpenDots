import { app, dialog, shell, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

const RELEASES_URL = 'https://github.com/rednosebrew1-ux/ploopAgent2/releases';

// Checks GitHub Releases for a newer ploop. macOS only installs an update by
// itself when the app is signed with an Apple Developer ID, so an unsigned
// build tells you a new version exists and opens the download page instead.
export function createUpdater(options: {
  signed: boolean;
  getWindow: () => BrowserWindow | undefined;
}) {
  let manual = false;

  const show = (message: string, detail?: string) => {
    const parent = options.getWindow();
    const box = { type: 'info' as const, message, detail, buttons: ['OK'] };
    return parent
      ? dialog.showMessageBox(parent, box)
      : dialog.showMessageBox(box);
  };

  // Set up on first use, and never allowed to stop ploop from starting: a
  // problem with updates is not a reason to lose the app.
  let ready = false;
  function setup() {
    if (ready) return true;
    try {
      listen();
      ready = true;
    } catch (error) {
      console.error('ploop updates are unavailable:', error);
    }
    return ready;
  }

  function listen() {
    // ploop releases are marked pre-release while the app is young.
    autoUpdater.allowPrerelease = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', async info => {
      const parent = options.getWindow();
      const box = {
        type: 'info' as const,
        message: `ploop ${info.version} is available`,
        detail: options.signed
          ? `You have ${app.getVersion()}. ploop will download it and restart.`
          : `You have ${app.getVersion()}. This build can't update itself, so ploop will open the download page.`,
        buttons: [
          options.signed ? 'Download and restart' : 'Open download page',
          'Later',
        ],
        defaultId: 0,
        cancelId: 1,
      };
      const result = parent
        ? await dialog.showMessageBox(parent, box)
        : await dialog.showMessageBox(box);
      if (result.response !== 0) return;

      if (options.signed) {
        void autoUpdater.downloadUpdate();
      } else {
        void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
      }
    });

    autoUpdater.on('update-not-available', () => {
      if (manual)
        void show(
          'You’re up to date',
          `ploop ${app.getVersion()} is the latest version.`,
        );
      manual = false;
    });

    autoUpdater.on('update-downloaded', () => {
      autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', error => {
      console.error('ploop update check failed:', error.message);
      if (manual) {
        void show(
          'ploop couldn’t check for updates',
          'Check your connection and try again.',
        );
      }
      manual = false;
    });
  }

  return {
    async check(isManual: boolean) {
      if (!app.isPackaged) {
        if (isManual) await show('Updates are off in development builds');
        return;
      }
      if (!setup()) {
        if (isManual) await show('ploop couldn’t check for updates');
        return;
      }
      manual = isManual;
      try {
        await autoUpdater.checkForUpdates();
      } catch {
        // The 'error' event above already reported it.
      }
    },
  };
}
