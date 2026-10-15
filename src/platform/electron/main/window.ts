// The main window (runtime.md 8.2). The Electron module is handed in, so that this file imports no Electron at
// run time and its options are tested without it.

import type { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences } from 'electron';

import { DEFAULT_SIZE, MIN_SIZE } from './window-state.ts';

/** `preload` is the built preload script, as an absolute path. */
export function webPreferences(preload: string): WebPreferences {
  return {
    contextIsolation: true,
    // These two together give the engine worker Node's fs and zlib (8.2 rule 1).
    sandbox: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: true,
    backgroundThrottling: false,
    preload,
  };
}

/** Where the window goes and how large it is: `placeWindow` of window-state.ts. Without one, the size of a first start. */
export interface WindowPlace { readonly width: number; readonly height: number; readonly x?: number; readonly y?: number }

/**
 * Never shown at creation: main.ts shows the window when its page is ready, and never in test mode. With
 * `byContent` the size is the page's and the frame comes on top of it, as the window of test mode is made: its
 * tests then have a page of the same pixels on every system. Without it the size is the window's, frame included
 * on Windows, as the user's window is kept and placed (window-state.ts).
 */
export function windowOptions(preload: string, place: WindowPlace = DEFAULT_SIZE, byContent = false): BrowserWindowConstructorOptions {
  return {
    width: place.width,
    height: place.height,
    // autoHideMenuBar too: with useContentSize alone, Electron makes the window taller by the native menu bar when
    // it receives its menu, and the page has that bar's height besides once the bar is hidden (measured: 1026).
    ...(byContent ? { useContentSize: true, autoHideMenuBar: true } : {}),
    ...(place.x !== undefined && place.y !== undefined ? { x: place.x, y: place.y } : {}),
    // A screen smaller than the least window still gets a window that fits it.
    minWidth: Math.min(MIN_SIZE.width, place.width),
    minHeight: Math.min(MIN_SIZE.height, place.height),
    show: false,
    title: 'Orogen',
    // The page's own colour (--og-bg-app of src/app/shell/theme.css), so that the window has it before the page draws.
    backgroundColor: '#1b1b1b',
    webPreferences: webPreferences(preload),
  };
}

/** The window with its page loading. Navigation and window.open are denied (8.2 rule 3). */
export function createMainWindow(
  Window: new (options: BrowserWindowConstructorOptions) => BrowserWindow,
  opts: { readonly preload: string; readonly page: string; readonly show: boolean; readonly platform: NodeJS.Platform; readonly place?: WindowPlace; readonly maximized?: boolean },
): { readonly win: BrowserWindow; readonly loaded: Promise<void> } {
  // A window that is never shown is one of test mode (main.ts): sized by its page.
  const win = new Window(windowOptions(opts.preload, opts.place, !opts.show));
  // 8.2 rule 7: on Windows and Linux the native menu would be a bar inside the window, above the menu bar the
  // page draws (8.7 rule 3). It stays the application's menu and is not shown; macOS shows it outside the window.
  if (opts.platform !== 'darwin') win.setMenuBarVisibility(false);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (opts.show) {
    win.once('ready-to-show', () => {
      if (opts.maximized) win.maximize();
      win.show();
    });
  }
  return { win, loaded: win.loadFile(opts.page) };
}
