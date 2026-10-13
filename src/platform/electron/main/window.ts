// The main window (runtime.md 8.2). The Electron module is handed in, so that this file imports no Electron at
// run time and its options are tested without it.

import type { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences } from 'electron';

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

/** Never shown at creation: main.ts shows the window when its page is ready, and never in test mode. */
export function windowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
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
  opts: { readonly preload: string; readonly page: string; readonly show: boolean; readonly platform: NodeJS.Platform },
): { readonly win: BrowserWindow; readonly loaded: Promise<void> } {
  const win = new Window(windowOptions(opts.preload));
  // 8.2 rule 7: on Windows and Linux the native menu would be a bar inside the window, above the menu bar the
  // page draws (8.7 rule 3). It stays the application's menu and is not shown; macOS shows it outside the window.
  if (opts.platform !== 'darwin') win.setMenuBarVisibility(false);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (opts.show) win.once('ready-to-show', () => win.show());
  return { win, loaded: win.loadFile(opts.page) };
}
