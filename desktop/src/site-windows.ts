import { BrowserWindow } from 'electron';
import { siteHost } from './origin';
import type { SitePage } from './sign-in';
import type { Login } from './vault';

// Runs ploop's fill script in its own JavaScript world, separate from the
// site's scripts.
const SCRIPT_WORLD_ID = 1000;

class WindowPage implements SitePage {
  constructor(
    private readonly window: BrowserWindow,
    private readonly shown: { value: boolean },
  ) {}

  url() {
    return this.window.webContents.getURL();
  }

  title() {
    return this.window.webContents.getTitle();
  }

  async load(url: string) {
    // Make the window visible the first time ploop uses it so you can see what
    // it is doing and step in for a code or a captcha.
    if (!this.shown.value) {
      this.shown.value = true;
      this.window.showInactive();
    }
    try {
      await this.window.loadURL(url);
    } catch (error) {
      // A redirect aborts the first load; the page that follows is checked by
      // the caller. Anything else is a real failure.
      if ((error as { code?: string }).code !== 'ERR_ABORTED') throw error;
    }
  }

  run(script: string) {
    return this.window.webContents.executeJavaScriptInIsolatedWorld(
      SCRIPT_WORLD_ID,
      [{ code: script }],
    );
  }

  wait(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  reveal() {
    this.window.show();
    this.window.focus();
  }
}

// One browser window per saved login, each with its own cookie jar that
// survives restarts, so a site stays signed in and accounts never mix.
export class SiteWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly shown = new Map<string, { value: boolean }>();

  open(login: Login): SitePage {
    let window = this.windows.get(login.id);
    if (window == null || window.isDestroyed()) {
      window = this.create(login);
      this.windows.set(login.id, window);
      this.shown.set(login.id, { value: false });
    }
    return new WindowPage(window, this.shown.get(login.id)!);
  }

  closeAll() {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }

  private create(login: Login) {
    const window = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: `ploop: ${siteHost(login.url)} (${login.username})`,
      webPreferences: {
        partition: `persist:ploop-login-${login.id}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });

    // Sites don't get the camera, microphone, location or notifications.
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    // A sign-in page that tries to open another window stays in this one.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void window.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    // Closing the window hides it; the session keeps running.
    window.on('close', event => {
      if (!window.isDestroyed() && this.windows.get(login.id) === window) {
        event.preventDefault();
        window.hide();
      }
    });
    return window;
  }
}
