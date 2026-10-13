// A test driver of its own for window.test.ts: the application loads it in its main process (testing.md 2.9,
// OROGEN_TEST_DRIVER). It prints what only that process knows, chooses every command of the native menu, asks
// the window to close as its close button would, and lets the application end by itself when the page has
// confirmed. The AppDriver of the harness reaches the page; the facts here are the window's.
'use strict';

const { BrowserWindow, Menu } = require('electron');

const SWITCHES = [
  'enable-webgpu-developer-features', 'disable-renderer-backgrounding', 'enable-unsafe-webgpu', 'enable-features',
  'force_high_performance_gpu', 'force-high-performance-gpu',
];
// What getLastWebPreferences() reports of the six the contract fixes; the other two are read where they show.
const PREFERENCES = ['contextIsolation', 'sandbox', 'nodeIntegration', 'nodeIntegrationInWorker'];
/** Long enough for a message to the page and its answer; nothing is asserted on it. */
const SETTLE_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function report({ app, win, errors }) {
  // Whatever goes wrong below, the application does not stay. Code 4 tells the test that this is how it ended.
  setTimeout(() => app.exit(4), 30_000);
  const page = (js) => win.webContents.executeJavaScript(js, true);
  const preferences = win.webContents.getLastWebPreferences() ?? {};
  const menu = Menu.getApplicationMenu();

  // The menu: every entry that is a command of the interface, chosen once.
  await page(`void (window.menuCommands = [], window.closeRequests = 0,
    orogenPlatform.onMenuCommand((id) => window.menuCommands.push(id)),
    orogenPlatform.onCloseRequested(() => { window.closeRequests++; }))`);
  for (const top of menu ? menu.items : []) {
    for (const item of top.submenu ? top.submenu.items : []) {
      if (item.type === 'normal' && !item.role) item.click();
    }
  }
  // Closing: the window's own close, as its button asks for it. The page hears of it and the window stays: a
  // page with nothing to save confirms at once, so the project is given an unsaved change first and the page asks.
  await page("void orogenTest.ctx.doc.getState().transact('Unsaved', (draft) => { draft.settings.seed += 1; })");
  win.close();
  await sleep(SETTLE_MS);

  const facts = {
    visible: win.isVisible(),
    menuBarVisible: win.isMenuBarVisible(),
    windows: BrowserWindow.getAllWindows().length,
    webPreferences: {
      ...Object.fromEntries(PREFERENCES.map((name) => [name, preferences[name]])),
      backgroundThrottling: win.webContents.getBackgroundThrottling(),
    },
    // The preload script ran: its object is on the page, and the page has nothing else of Node.
    page: await page('({ bridge: typeof orogenPlatform, require: typeof require, process: typeof process })'),
    switches: Object.fromEntries(SWITCHES.map((name) => [name, app.commandLine.hasSwitch(name) ? app.commandLine.getSwitchValue(name) : null])),
    userData: app.getPath('userData'),
    url: win.webContents.getURL(),
    menu: menu ? menu.items.map((item) => item.label) : [],
    menuCommands: await page('window.menuCommands'),
    closeRequests: await page('window.closeRequests'),
    openAfterCloseRequest: !win.isDestroyed(),
    errors: [...errors],
  };
  process.stdout.write(`\nOROGEN_FACTS ${JSON.stringify(facts)}\n`, () => {
    // The page confirms: the window closes, and with its last window the application quits.
    page('void orogenPlatform.confirmClose()').catch(() => {});
  });
};
