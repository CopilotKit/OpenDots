import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { confirmPresence } from './auth';
import { startBridge, type BridgeService } from './bridge';
import { LoginService, LoginServiceError } from './login-service';
import { intelligenceFromEnvFile, SettingsStore } from './settings';
import { SiteWindows } from './site-windows';
import { startServer, type RunningServer } from './server-process';
import { createUpdater } from './updater';
import { Vault } from './vault';

const CLIPBOARD_CLEAR_MS = 30_000;

const loginInput = z.object({
  label: z.string().optional(),
  url: z.string(),
  username: z.string(),
  password: z.string(),
  notes: z.string().optional(),
  agentAccess: z.boolean().optional(),
});
const loginPatch = loginInput.partial();
const settingsPatch = z.object({
  openrouterApiKey: z.string().optional(),
  intelligenceApiKey: z.string().optional(),
  intelligenceApiUrl: z
    .string()
    .regex(/^(https?:\/\/\S+)?$/, 'The Intelligence API address must start with http.')
    .optional(),
  intelligenceWsUrl: z
    .string()
    .regex(/^(wss?:\/\/\S+)?$/, 'The Intelligence gateway address must start with ws.')
    .optional(),
  telemetryId: z
    .string()
    .regex(/^[\w-]*$/, 'That telemetry ID doesn’t look right.')
    .optional(),
  model: z
    .string()
    .regex(/^([\w.:/-]+)?$/, 'That model name doesn’t look right.')
    .optional(),
  // Checked again where they are used, but a bad value shouldn't be saved.
  sshHost: z
    .string()
    .regex(
      /^([A-Za-z0-9][A-Za-z0-9._:-]*)?$/,
      'That address doesn’t look right.',
    )
    .optional(),
  sshUser: z
    .string()
    .regex(/^([A-Za-z_][A-Za-z0-9._-]*)?$/, 'That username doesn’t look right.')
    .optional(),
  sshPort: z
    .string()
    .regex(/^(\d{1,5})?$/, 'The port must be a number.')
    .refine(
      value => value === '' || (Number(value) >= 1 && Number(value) <= 65_535),
      'The port must be between 1 and 65535.',
    )
    .optional(),
  sshKeyPath: z
    .string()
    .refine(
      value => value === '' || value.startsWith('/'),
      'Use the full path of the key file.',
    )
    .optional(),
});
const idSchema = z.string();

function splashPage(message: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>ploop</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;font:15px -apple-system,system-ui,sans-serif;color:#1f2937;background:#fff">
<p>${message}</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function openExternally(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Name the app, and so its data folder, ploop in development too.
  app.setName('ploop');
  app.setPath('userData', path.join(app.getPath('appData'), 'ploop'));
  await app.whenReady();

  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox(
      'ploop can’t use the Keychain',
      'macOS did not let ploop reach its encryption key, so the vault can’t be opened safely. Quit and reopen ploop, and choose Always Allow if macOS asks.',
    );
    app.quit();
    return;
  }

  const userData = app.getPath('userData');
  const box = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (data: Buffer) => safeStorage.decryptString(data),
  };
  const vault = new Vault({ file: path.join(userData, 'vault.json'), box });
  const settings = new SettingsStore({
    file: path.join(userData, 'settings.json'),
    box,
  });
  const siteWindows = new SiteWindows();
  const service = new LoginService({
    vault,
    openPage: login => siteWindows.open(login),
  });

  // The agent may only sign in after the person agrees, each time.
  const bridgeService: BridgeService = {
    listForAgent: () => service.listForAgent(),
    readPageForAgent: (site, username, url) =>
      service.readPageForAgent(site, username, url),
    signInForAgent: async (site, username) => {
      const options = {
        type: 'question' as const,
        buttons: ['Allow', 'Don’t Allow'],
        defaultId: 1,
        cancelId: 1,
        message: `Let ploop sign in to ${site}?`,
        detail: `ploop wants to sign in as ${username} using the password saved in your vault. It never sees the password.`,
      };
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (response !== 0) {
        throw new LoginServiceError(
          `The owner didn’t allow signing in to ${site}.`,
          403,
        );
      }
      return service.signInForAgent(site, username);
    },
  };

  // The private door between the agent's server and the vault.
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'ploop-'));
  const token = randomBytes(32).toString('hex');
  const bridge = await startBridge({
    socketPath: path.join(bridgeDir, 'bridge.sock'),
    token,
    service: bridgeService,
  });

  let server: RunningServer | undefined;
  let mainWindow: BrowserWindow | undefined;
  let restarting = false;
  let quitting = false;

  const updater = createUpdater({
    signed: __PLOOP_SIGNED__,
    getWindow: () => mainWindow,
  });

  async function launchServer(port?: number) {
    const env = {
      ...(await settings.toEnv()),
      OWNER_TOKEN: await settings.ownerToken(),
      PLOOP_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock'),
      PLOOP_BRIDGE_TOKEN: token,
      DATABASE_PATH: path.join(userData, 'data', 'ploop.sqlite'),
    };
    const running = await startServer({
      env,
      logFile: path.join(userData, 'logs', 'server.log'),
      port,
    });
    running.onExit(() => {
      if (restarting || quitting) return;
      void mainWindow?.loadURL(
        splashPage('ploop’s server stopped. Quit ploop and open it again.'),
      );
    });
    server = running;
    return running;
  }

  function createWindow() {
    const window = new BrowserWindow({
      width: 1120,
      height: 820,
      minWidth: 720,
      minHeight: 560,
      title: 'ploop',
      backgroundColor: '#fff1f5',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // The chat page renders text from the model and from websites. Nothing it
    // links to may open inside this window, where the vault is within reach.
    window.webContents.on('will-navigate', (event, url) => {
      if (!isOurServer(url)) {
        event.preventDefault();
        openExternally(url);
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });
    window.on('closed', () => {
      mainWindow = undefined;
      app.quit();
    });
    return window;
  }

  async function go(pathname: string) {
    if (mainWindow == null || server == null) return;
    await mainWindow.loadURL(`${server.origin}${pathname}`);
  }

  async function restartServer() {
    if (mainWindow == null || server == null) return;
    const current = new URL(mainWindow.webContents.getURL());
    const returnTo = `${current.pathname}${current.hash}`;
    const { port } = server;
    restarting = true;
    await mainWindow.loadURL(splashPage('Applying your settings…'));
    await server.stop();
    try {
      await launchServer(port);
      await go(returnTo);
    } catch {
      await mainWindow?.loadURL(
        splashPage(
          'ploop’s server did not restart. Quit ploop and open it again.',
        ),
      );
    } finally {
      restarting = false;
    }
  }

  function isOurServer(url: string) {
    if (server == null) return false;
    try {
      return new URL(url).origin === server.origin;
    } catch {
      return false;
    }
  }

  // Only the chat window's own page, served by our own server, may use the
  // vault. A frame inside it, a navigated-away page or a site window is refused.
  function isTrusted(event: IpcMainInvokeEvent) {
    if (mainWindow == null) return false;
    if (event.sender !== mainWindow.webContents) return false;
    if (event.senderFrame !== event.sender.mainFrame) return false;
    return isOurServer(event.senderFrame?.url ?? '');
  }

  function handle<T>(channel: string, run: (...args: unknown[]) => Promise<T>) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrusted(event)) return { ok: false, error: 'Not allowed.' };
      try {
        return { ok: true, value: await run(...args) };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : 'Something went wrong.',
        };
      }
    });
  }

  async function revealable(id: string, reason: string) {
    const login = await vault.get(id);
    if (login == null) throw new Error('That login no longer exists.');
    if (!(await confirmPresence(`${reason} for ${login.label}`))) {
      throw new Error('Cancelled.');
    }
    return login;
  }

  // The page needs the server's owner token before its own scripts run, so the
  // preload asks for it synchronously.
  ipcMain.on('owner-token', event => {
    const trusted =
      mainWindow != null &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isOurServer(event.senderFrame?.url ?? '');
    void settings
      .ownerToken()
      .then(value => (event.returnValue = trusted ? value : ''))
      .catch(() => (event.returnValue = ''));
  });

  handle('vault:list', () => vault.list());
  handle('vault:add', async input => vault.add(loginInput.parse(input)));
  handle('vault:update', async (id, patch) =>
    vault.update(idSchema.parse(id), loginPatch.parse(patch)),
  );
  handle('vault:remove', async id => vault.remove(idSchema.parse(id)));
  handle('vault:reveal', async id => {
    const login = await revealable(idSchema.parse(id), 'Show the password');
    return login.password;
  });
  handle('vault:copy-password', async id => {
    const login = await revealable(idSchema.parse(id), 'Copy the password');
    await clipboard.writeText(login.password);
    // Clear it again, unless something else has been copied since.
    setTimeout(() => {
      void clipboard.readText().then(current => {
        if (current === login.password) clipboard.clear();
      });
    }, CLIPBOARD_CLEAR_MS);
  });
  handle('vault:sign-in', async id => service.signInById(idSchema.parse(id)));
  handle('settings:status', () => settings.status());
  handle('settings:save', async patch => {
    await settings.save(settingsPatch.parse(patch));
    // Restart after replying, so the page gets its answer first.
    setTimeout(() => void restartServer(), 100);
  });
  // Reads the Intelligence connection from the .env file the CopilotKit CLI
  // wrote, so nobody has to copy keys by hand.
  handle('settings:import-intelligence', async () => {
    if (mainWindow == null) throw new Error('Not allowed.');
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the .env file the CopilotKit CLI wrote',
      defaultPath: app.getPath('home'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || file == null) return { imported: false };
    if ((await stat(file)).size > 256 * 1024) {
      throw new Error('That file is too large to be a .env file.');
    }
    const patch = settingsPatch.parse(
      intelligenceFromEnvFile(await readFile(file, 'utf8')),
    );
    await settings.save(patch);
    setTimeout(() => void restartServer(), 100);
    return {
      imported: true,
      local: Boolean(patch.intelligenceApiUrl || patch.intelligenceWsUrl),
    };
  });
  handle('app:info', async () => ({
    version: app.getVersion(),
    signed: __PLOOP_SIGNED__,
  }));
  handle('app:check-for-updates', () => updater.check(true));

  // Nothing a page asks the browser for (camera, location, notifications) is
  // granted, and web views are never attached.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'ploop',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void updater.check(true) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Chat',
          accelerator: 'CmdOrCtrl+1',
          click: () => void go('/'),
        },
        {
          label: 'Vault',
          accelerator: 'CmdOrCtrl+2',
          click: () => void go('/#vault'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('before-quit', () => {
    quitting = true;
    siteWindows.closeAll();
    void server?.stop();
    void bridge.close();
    rmSync(bridgeDir, { recursive: true, force: true });
  });

  mainWindow = createWindow();
  await mainWindow.loadURL(splashPage('Starting ploop…'));

  try {
    const running = await launchServer();
    // First run: nothing works without a model key, so start on the keys.
    const status = await settings.status();
    const ready = status.openrouterApiKey && status.intelligenceApiKey;
    await mainWindow.loadURL(`${running.origin}/${ready ? '' : '#vault'}`);
  } catch (error) {
    await mainWindow.loadURL(
      splashPage(
        `ploop couldn’t start: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
    );
  }

  setTimeout(() => void updater.check(false), 5_000);
}

main().catch(error => {
  dialog.showErrorBox('ploop couldn’t start', String(error));
  app.quit();
});
