// The window of runtime.md 8.2, without Electron: its options, and what createMainWindow does with the window
// class it is handed. tests/ui/platform/window.test.ts reads the same facts from the running application.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMainWindow, webPreferences, windowOptions } from '../../../../src/platform/electron/main/window.ts';

type Options = ReturnType<typeof windowOptions>;

/** What createMainWindow uses of a BrowserWindow, recorded. */
class FakeWindow {
  static made: FakeWindow[] = [];
  /** Listeners of the window's webContents, by event. */
  readonly contents = new Map<string, (...args: unknown[]) => void>();
  /** Listeners registered with once(), by event. */
  readonly onces = new Map<string, () => void>();
  openHandler: (() => unknown) | null = null;
  loaded: string | null = null;
  shown = 0;
  /** What setMenuBarVisibility was called with, in order. */
  readonly menuBar: boolean[] = [];
  readonly options: Options;
  readonly webContents = {
    on: (event: string, listener: (...args: unknown[]) => void): void => void this.contents.set(event, listener),
    setWindowOpenHandler: (handler: () => unknown): void => { this.openHandler = handler; },
  };
  constructor(options: Options) {
    this.options = options;
    FakeWindow.made.push(this);
  }
  once(event: string, listener: () => void): this {
    this.onces.set(event, listener);
    return this;
  }
  loadFile(file: string): Promise<void> {
    this.loaded = file;
    return Promise.resolve();
  }
  show(): void {
    this.shown++;
  }
  setMenuBarVisibility(visible: boolean): void {
    this.menuBar.push(visible);
  }
}

function make(show: boolean, platform: NodeJS.Platform = 'linux'): FakeWindow {
  FakeWindow.made = [];
  createMainWindow(FakeWindow as never, { preload: '/app/dist/preload.cjs', page: '/app/dist/index.html', show, platform });
  return FakeWindow.made[0]!;
}

test('window: the web preferences are exactly those the contract fixes', () => {
  assert.deepEqual(webPreferences('/app/dist/preload.cjs'), {
    contextIsolation: true,
    sandbox: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: true,
    backgroundThrottling: false,
    preload: '/app/dist/preload.cjs',
  });
});

test('window: it is created hidden, with those preferences', () => {
  const options = windowOptions('/app/dist/preload.cjs');
  assert.equal(options.show, false);
  assert.deepEqual(options.webPreferences, webPreferences('/app/dist/preload.cjs'));
  assert.equal(make(false).options.show, false);
});

test('window: navigation and window.open are denied, and the packaged page is what loads', () => {
  const win = make(false);
  let prevented = 0;
  win.contents.get('will-navigate')!({ preventDefault: () => void prevented++ });
  assert.equal(prevented, 1);
  assert.deepEqual(win.openHandler!(), { action: 'deny' });
  assert.equal(win.loaded, '/app/dist/index.html');
});

test('window: it is shown when its page is ready, and never when asked not to be', () => {
  const hidden = make(false);
  assert.equal(hidden.onces.get('ready-to-show'), undefined, 'test mode waits for nothing that would show the window');
  const visible = make(true);
  assert.equal(visible.shown, 0, 'not before the page has something to show');
  visible.onces.get('ready-to-show')!();
  assert.equal(visible.shown, 1);
});

test('window: the window of test mode, never shown, is sized by its page; the window the user sees by its frame', () => {
  // testing.md 2.9: without useContentSize the frame of a Windows window takes its pixels from the page, and
  // without autoHideMenuBar Electron gives the page the height of the hidden native menu bar besides.
  const hidden = make(false, 'win32').options;
  assert.deepEqual([hidden.useContentSize, hidden.autoHideMenuBar, hidden.width, hidden.height], [true, true, 1600, 1000]);
  const shown = make(true, 'win32').options;
  assert.deepEqual([shown.useContentSize, shown.autoHideMenuBar], [undefined, undefined], 'the user\'s window keeps its size and place as before (window-state.ts)');
  assert.deepEqual([windowOptions('/app/dist/preload.cjs').useContentSize, windowOptions('/app/dist/preload.cjs', undefined, true).useContentSize], [undefined, true]);
});

test('window: the native menu is no bar inside the window, where the page draws its own', () => {
  // Windows and Linux put the application menu into the window; macOS shows it outside and is left alone.
  assert.deepEqual(make(true, 'win32').menuBar, [false]);
  assert.deepEqual(make(true, 'linux').menuBar, [false]);
  assert.deepEqual(make(true, 'darwin').menuBar, []);
  // The page's own colour before the page has drawn: --og-bg-app of the theme.
  assert.equal(windowOptions('/app/dist/preload.cjs').backgroundColor, '#1b1b1b');
});
