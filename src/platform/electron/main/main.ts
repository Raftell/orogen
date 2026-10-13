// The main process (runtime.md 8.1, 8.2, 8.6): launch switches, the window, the native menu, dialogs, project
// files as text, preferences, and the test mode of testing.md 2.9. Built to dist/main.cjs, which package.json names.

import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS, PROJECT_EXTENSION, type LaunchInfo, type Preferences } from '../ipc.ts';
import { readTextFile, writeTextFile } from './files.ts';
import { LaunchError, readLaunch, type Launch } from './launch.ts';
import { menuTemplate } from './menu.ts';
import { createPreferenceStore } from './preferences.ts';
import { applySwitches, launchSwitches } from './switches.ts';
import { createMainWindow } from './window.ts';

/** What the test driver is called with (testing.md 2.9). `errors` is what this process has recorded since launch. */
interface DriverContext {
  readonly app: typeof app;
  readonly win: BrowserWindow;
  readonly errors: readonly string[];
}

/** Recorded errors kept for AppDriver.errors(); a page that logs in a loop does not grow the list without end. */
const ERRORS_KEPT = 500;

function readLaunchOrExit(): Launch {
  try {
    return readLaunch(process.env, process.argv, { packaged: app.isPackaged, cwd: process.cwd() });
  } catch (thrown) {
    if (!(thrown instanceof LaunchError)) throw thrown;
    console.error(`[orogen] ${thrown.message}`);
    // Test mode opens no dialog; whether this is one is asked of the variable itself, since nothing was read.
    if (process.env.OROGEN_TEST !== '1') dialog.showErrorBox('Orogen', thrown.message);
    process.exit(2);
  }
}

const launch = readLaunchOrExit();
const errors: string[] = [];

function record(source: string, message: string): void {
  if (errors.length < ERRORS_KEPT) errors.push(`[${source}] ${message}`);
}

if (launch.test) {
  // Preferences, and everything else Chromium keeps per user, live in a folder of this run alone.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-test-'));
  app.setPath('userData', userData);
  process.on('exit', () => {
    // Chromium writes its last state into the folder once more after this; whoever launched the application
    // removes that (tests/helpers/app.ts). The folder is the system's temporary one either way.
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // A file that is still open.
    }
  });
  // With a listener Electron shows no dialog for an uncaught exception: test mode opens none.
  process.on('uncaughtException', (error) => record('main', error.stack ?? String(error)));
  process.on('unhandledRejection', (reason) => record('main', reason instanceof Error ? reason.stack ?? String(reason) : String(reason)));
  // A GPU process that goes is no error of the application: the session recovers from it (runtime.md 7.8).

  // Started by a test, over a channel: when the test is gone, nothing is left to close this application.
  if (typeof process.send === 'function') process.on('disconnect', () => app.exit(1));
}

applySwitches(app.commandLine, launchSwitches(process.platform, launch.software));

async function start(): Promise<void> {
  const preferences = createPreferenceStore(app.getPath('userData'));
  const { win, loaded } = createMainWindow(BrowserWindow, {
    preload: path.join(__dirname, 'preload.cjs'),
    page: path.join(__dirname, 'index.html'),
    show: !launch.test,
    platform: process.platform,
  });
  const contents = win.webContents;

  /** The renderer process is gone or the page never loaded: nobody is there to answer. */
  let pageDead = false;
  /** The page has loaded: its preload script listens. */
  let pageReady = false;
  if (launch.test) {
    contents.on('console-message', (event) => {
      if (event.level === 'error') record('page', `${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    contents.on('preload-error', (_event, file, error) => record('preload', `${file}: ${error.stack ?? error.message}`));
  }
  contents.on('render-process-gone', (_event, details) => {
    pageDead = true;
    record('renderer', `the renderer process is gone: ${details.reason}`);
    console.error(`[orogen] the renderer process is gone: ${details.reason}`);
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    pageDead = true;
    record('page', `${url} did not load: ${description} (${code})`);
    console.error(`[orogen] ${url} did not load: ${description} (${code})`);
  });

  // Only the top-level frame of the main window is answered.
  const fromPage = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => !win.isDestroyed() && event.senderFrame === contents.mainFrame;
  const handle = <A extends unknown[], R>(channel: string, handler: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromPage(event)) throw new Error('This channel serves the main window only');
      return handler(...(args as A));
    });
  };
  const listen = <A extends unknown[]>(channel: string, listener: (...args: A) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (fromPage(event)) listener(...(args as A));
    });
  };

  const info: LaunchInfo = { gpuProfile: launch.profile, testMode: launch.test, launchProject: launch.project };
  ipcMain.on(CHANNELS.launchInfo, (event) => {
    event.returnValue = fromPage(event) ? info : null;
  });

  // ---- dialogs. Test mode opens none: each answers as a cancelled dialog does. ---------------------------------------
  const projectFilter = { name: 'Orogen Project', extensions: [PROJECT_EXTENSION] };
  const open = async (options: OpenDialogOptions): Promise<string | null> => {
    if (launch.test) return null;
    const result = await dialog.showOpenDialog(win, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  handle(CHANNELS.openProjectDialog, () => open({ properties: ['openFile'], filters: [projectFilter] }));
  handle(CHANNELS.openFileDialog, (extensions: unknown) => {
    const list = Array.isArray(extensions) ? extensions.filter((e): e is string => typeof e === 'string' && /^[A-Za-z0-9]+$/.test(e)) : [];
    return open({ properties: ['openFile'], filters: list.length > 0 ? [{ name: 'Files', extensions: list }] : [] });
  });
  handle(CHANNELS.chooseFolder, () => open({ properties: ['openDirectory', 'createDirectory'] }));
  handle(CHANNELS.saveProjectDialog, async (suggestedPath: unknown) => {
    if (launch.test) return null;
    const options: SaveDialogOptions = { filters: [projectFilter] };
    if (typeof suggestedPath === 'string' && suggestedPath !== '') options.defaultPath = suggestedPath;
    const result = await dialog.showSaveDialog(win, options);
    if (result.canceled || !result.filePath) return null;
    // A dialog that was given a name without the extension returns it so on some desktops.
    return path.extname(result.filePath) === '' ? `${result.filePath}.${PROJECT_EXTENSION}` : result.filePath;
  });

  // ---- text files and preferences ---------------------------------------------------------------------------------------
  handle(CHANNELS.readTextFile, (file: string) => readTextFile(file));
  handle(CHANNELS.writeTextFile, (file: string, text: string) => writeTextFile(file, text));
  handle(CHANNELS.getPreferences, () => preferences.get());
  handle(CHANNELS.setPreferences, async (patch: Partial<Preferences>) => {
    await preferences.set(patch);
    if (patch !== null && typeof patch === 'object' && Object.hasOwn(patch, 'keymap')) await setMenu();
  });

  // ---- the native menu ------------------------------------------------------------------------------------------------
  const sendCommand = (commandId: string): void => {
    if (!win.isDestroyed() && !pageDead) contents.send(CHANNELS.menuCommand, commandId);
  };
  async function setMenu(): Promise<void> {
    const { keymap } = await preferences.get();
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(sendCommand, keymap)));
  }

  // ---- builds (8.2 rule 5) --------------------------------------------------------------------------------------------
  let blocker: number | null = null;
  const setBuildActive = (active: boolean): void => {
    if (active && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };
  listen(CHANNELS.setBuildActive, (active: unknown) => setBuildActive(active === true));
  listen(CHANNELS.showInFolder, (file: unknown) => {
    // A file manager is a window of its own: test mode opens none.
    if (!launch.test && typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(path.normalize(file));
  });

  // ---- closing: the page is asked first, since it knows whether the project is saved --------------------------------
  let closing = false;
  win.on('close', (event) => {
    // A page that has not loaded yet, or is gone, has nothing to save and nobody to ask.
    if (closing || !pageReady || pageDead || contents.isDestroyed() || contents.isCrashed()) return;
    event.preventDefault();
    contents.send(CHANNELS.closeRequested);
  });
  listen(CHANNELS.confirmClose, () => {
    closing = true;
    win.close();
  });
  win.on('closed', () => setBuildActive(false));

  // Every channel is served before the first await: the page may speak as soon as it runs.
  await setMenu();
  try {
    await loaded;
    pageReady = true;
  } catch (thrown) {
    // did-fail-load has recorded it. The window stays, so that a person sees an empty page and a test its driver's report.
    pageDead = true;
    if (!launch.test) dialog.showErrorBox('Orogen', `The interface did not load: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }

  if (launch.driver !== null) {
    const load = createRequire(path.join(app.getAppPath(), 'package.json'));
    const loadedModule: unknown = load(launch.driver);
    const run = typeof loadedModule === 'function' ? loadedModule : (loadedModule as { default?: unknown } | null)?.default;
    if (typeof run !== 'function') throw new Error(`${launch.driver} has no default export to call`);
    const context: DriverContext = { app, win, errors };
    (run as (context: DriverContext) => void)(context);
  }
}

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(start).catch((thrown: unknown) => {
  console.error('[orogen] the application did not start', thrown);
  if (!launch.test) dialog.showErrorBox('Orogen', `The application did not start: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  app.exit(1);
});
