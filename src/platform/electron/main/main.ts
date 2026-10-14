// The main process (runtime.md 8.1, 8.2, 8.6): launch switches, the window, the native menu, dialogs, project
// files as text, preferences, and the test mode of testing.md 2.9. Built to dist/main.cjs, which package.json names.

import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, screen, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS, PROJECT_EXTENSION, type LaunchInfo, type Preferences } from '../ipc.ts';
import { readTextFile, writeFailure, writeTextFile } from './files.ts';
import { buildFile, documentFile, externalUrl, statPath } from './open.ts';
import { LaunchError, readLaunch, secondStartProject, type Launch } from './launch.ts';
import { createLog } from './log.ts';
import { menuTemplate } from './menu.ts';
import { createPreferenceStore } from './preferences.ts';
import { createRecoveryStore } from './recovery.ts';
import { applySwitches, launchSwitches } from './switches.ts';
import { createMainWindow } from './window.ts';
import { placeWindow, readWindowState, writeWindowState } from './window-state.ts';

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

/** How often test mode loads the window again after its page's process went: a page that dies at every start is not loaded for ever. */
const TEST_RELOADS_MAX = 3;

/**
 * One application per user (8.2 rule 8): a second start hands its project file to the first and ends. Two
 * applications would write one preferences file and one recovery file, and, opened on one project file, each
 * would save over the other. Test mode takes no lock: a test runs beside the user's own application, and its
 * files are in a folder of its own.
 */
const first = launch.test || app.requestSingleInstanceLock();
/** Set once the window is there: what a second start is answered with. */
let onSecondStart: ((project: string | null) => void) | null = null;
if (first && !launch.test) {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    onSecondStart?.(secondStartProject(argv, { packaged: app.isPackaged, cwd: workingDirectory }));
  });
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
  const userData = app.getPath('userData');
  const preferences = createPreferenceStore(userData);
  const recovery = createRecoveryStore(userData);
  // 8.2 rule 10. Test mode writes none: its folder is removed with the run.
  const log = launch.test ? null : createLog(userData);
  if (log) {
    process.on('uncaughtExceptionMonitor', (error) => log.write('main', error.stack ?? String(error)));
    process.on('unhandledRejection', (reason) => log.write('main', reason instanceof Error ? reason.stack ?? String(reason) : String(reason)));
    app.on('child-process-gone', (_event, details) => {
      // The GPU process that goes is recovered from (7.8); that it went, and how often, is what a report needs.
      if (details.reason !== 'clean-exit') log.write(details.type, `the ${details.type} process is gone: ${details.reason} (exit code ${details.exitCode})`);
    });
  }
  // 8.2 rule 9: where the window was, as far as that is still on a screen, and never larger than the screen.
  // A window that is never shown has the size its tests expect.
  const kept = launch.test ? null : readWindowState(userData);
  const place = launch.test ? null : placeWindow(kept, [screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter((display) => display.id !== screen.getPrimaryDisplay().id)].map((display) => display.workArea));
  const { win, loaded } = createMainWindow(BrowserWindow, {
    preload: path.join(__dirname, 'preload.cjs'),
    page: path.join(__dirname, 'index.html'),
    show: !launch.test,
    platform: process.platform,
    ...(place ? { place, maximized: place.maximized } : {}),
  });
  const contents = win.webContents;

  /** The renderer process is gone or the page never loaded: nobody is there to answer. */
  let pageDead = false;
  /** The page has loaded: its preload script listens. */
  let pageReady = false;
  /** Set when the window is to close without asking the page: the page confirmed, or cannot be asked. */
  let closing = false;
  if (launch.test) {
    contents.on('console-message', (event) => {
      if (event.level === 'error') record('page', `${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    contents.on('preload-error', (_event, file, error) => record('preload', `${file}: ${error.stack ?? error.message}`));
  } else {
    contents.on('console-message', (event) => {
      if (event.level === 'error') log?.write('page', `${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    contents.on('preload-error', (_event, file, error) => log?.write('preload', `${file}: ${error.stack ?? error.message}`));
  }

  /**
   * The page's process went (8.2 rule 11): its window would stay empty, and with it everything the user sees of
   * the application. The window is loaded again, after a question outside test mode; the page then offers what
   * it had kept of an unsaved project (8.6, recovery). The engine worker lived in that process and starts with it.
   */
  let reloads = 0;
  async function pageGone(reason: string): Promise<void> {
    if (win.isDestroyed() || closing) return;
    let reload = reloads < TEST_RELOADS_MAX || !launch.test;
    if (!launch.test) {
      const answer = await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Orogen',
        message: 'The interface of Orogen stopped working',
        detail: `Its process ended (${reason}). Reloading starts it again, with the engine. A project with unsaved changes is offered as it was kept a few seconds before this happened; a saved project is opened from its file.`,
        buttons: ['Reload', 'Close Orogen'],
        defaultId: 0,
        cancelId: 1,
      });
      reload = answer.response === 0;
    }
    if (win.isDestroyed()) return;
    if (!reload) {
      if (!launch.test) {
        closing = true;
        win.destroy();
      }
      return;
    }
    reloads++;
    pageDead = false;
    contents.once('did-finish-load', () => { pageReady = true; });
    contents.reload();
  }
  contents.on('render-process-gone', (_event, details) => {
    pageDead = true;
    pageReady = false;
    record('renderer', `the renderer process is gone: ${details.reason}`);
    console.error(`[orogen] the renderer process is gone: ${details.reason}`);
    log?.write('renderer', `the renderer process is gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason !== 'clean-exit') void pageGone(details.reason);
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    pageDead = true;
    record('page', `${url} did not load: ${description} (${code})`);
    console.error(`[orogen] ${url} did not load: ${description} (${code})`);
    log?.write('page', `${url} did not load: ${description} (${code})`);
  });
  // A page that hangs answers nothing, the question whether it may close included: the window could not be
  // closed from its own frame. The user is asked, and may end the application; test mode opens no dialog.
  let asking = false;
  win.on('unresponsive', () => {
    record('main', 'the window does not respond');
    log?.write('main', 'the window does not respond');
    if (launch.test || asking || win.isDestroyed()) return;
    asking = true;
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Orogen',
      message: 'Orogen is not responding',
      detail: 'The interface has not answered for several seconds. Waiting may be enough. Closing ends Orogen now; a project with unsaved changes is offered at the next start as it was last kept.',
      buttons: ['Wait', 'Close Orogen'],
      defaultId: 0,
      cancelId: 0,
    }).then((answer) => {
      asking = false;
      if (answer.response === 1 && !win.isDestroyed()) {
        closing = true;
        win.destroy();
      }
    });
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
  handle(CHANNELS.writeTextFile, async (file: string, text: string) => {
    try {
      await writeTextFile(file, text);
    } catch (thrown) {
      // The page shows this sentence as it is, and the system's would name a temporary file nobody chose.
      throw new Error(typeof file === 'string' ? writeFailure(thrown, file) : String(thrown));
    }
  });
  handle(CHANNELS.readRecovery, () => recovery.read());
  handle(CHANNELS.writeRecovery, (kept: unknown) => recovery.write(kept));
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

  // ---- the system's default programs (8.6): an address, a page of the documentation, a file of a build ---------------
  // Packaged, the documentation lies beside the archive of the application (electron-builder.yml): a program of
  // the system cannot open a file inside the archive.
  const documentation = app.isPackaged ? path.join(process.resourcesPath, 'docs', 'user') : path.join(app.getAppPath(), 'docs', 'user');
  /** Opens what the rules of open.ts let through. Test mode opens nothing and answers the same. */
  const openFile = async (file: string | null): Promise<boolean> => {
    if (file === null) return false;
    if (launch.test) return true;
    // Resolves with the reason when the system could not, and with nothing when it could.
    return (await shell.openPath(file)) === '';
  };
  handle(CHANNELS.statPath, (file: unknown, projectPath: unknown) => statPath(file, projectPath));
  handle(CHANNELS.openExternal, async (url: unknown) => {
    const address = externalUrl(url);
    if (address === null) return false;
    if (launch.test) return true;
    return shell.openExternal(address).then(() => true, () => false);
  });
  handle(CHANNELS.openDocument, async (name: unknown) => openFile(await documentFile(documentation, name)));
  handle(CHANNELS.openBuildFile, async (file: unknown) => openFile(await buildFile(file)));

  // ---- a second start of the application (8.2 rule 8): this window comes forward and opens what it was given -------
  onSecondStart = (project) => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (project !== null && pageReady && !pageDead) contents.send(CHANNELS.openRequested, project);
  };

  // ---- closing: the page is asked first, since it knows whether the project is saved --------------------------------
  const keepPlace = (): void => {
    if (!launch.test && !win.isDestroyed()) writeWindowState(userData, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  win.on('close', (event) => {
    // A page that has not loaded yet, or is gone, has nothing to save and nobody to ask.
    if (closing || !pageReady || pageDead || contents.isDestroyed() || contents.isCrashed()) {
      keepPlace();
      return;
    }
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

if (!first) {
  // Another run of the application has the lock: it was told of this start, and of the project file it was given.
  app.quit();
} else {
  void app.whenReady().then(start).catch((thrown: unknown) => {
    console.error('[orogen] the application did not start', thrown);
    if (!launch.test) dialog.showErrorBox('Orogen', `The application did not start: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    app.exit(1);
  });
}
