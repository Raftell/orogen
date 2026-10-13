// The main-process end of the application test driver (testing.md 2.9). In test mode the application loads this
// module once its window has loaded and calls it with { app, win, errors }; launchApp (tests/helpers/app.ts)
// started the application with a channel to its parent, and every AppDriver call is one request on it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const POLL_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The channel to the test carries JSON: Electron's V8 and the test's write different versions of the
// structured-clone format. A result of eval() is structured-cloned from the page to here; what JSON has no word
// for is tagged for the last step, and decoded by tests/helpers/app.ts.
function encode(value, path = new Set()) {
  if (value === undefined) return { $: 'undefined' };
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $: 'number', v: String(value) };
  if (typeof value === 'bigint') return { $: 'bigint', v: String(value) };
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return { $: 'date', v: value.getTime() };
  if (value instanceof ArrayBuffer) return { $: 'buffer', v: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) {
    return { $: 'view', t: value.constructor.name, v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (value instanceof Error) return { $: 'error', name: value.name, message: value.message };
  if (path.has(value)) throw new Error('The value refers to itself; the test driver sends trees only');
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, path));
    if (value instanceof Map) return { $: 'map', v: [...value].map(([k, v]) => [encode(k, path), encode(v, path)]) };
    if (value instanceof Set) return { $: 'set', v: [...value].map((item) => encode(item, path)) };
    const members = Object.fromEntries(Object.keys(value).map((key) => [key, encode(value[key], path)]));
    return Object.hasOwn(value, '$') ? { $: 'object', v: members } : members;
  } finally {
    path.delete(value);
  }
}

module.exports = function drive({ app, win, errors }) {
  if (typeof process.send !== 'function') {
    console.error('[orogen] the test driver was loaded without a channel to the test: launchApp starts the application');
    app.exit(3);
    return;
  }
  const contents = win.webContents;

  /**
   * Evaluates an expression in the page and awaits it. What it throws is caught there and thrown here with its
   * message: executeJavaScript itself says only that a script failed, and would leave the error in the console.
   */
  async function evaluate(js) {
    const wrapped = `(async () => {
      try {
        return { ok: true, value: await (${js}
        ) };
      } catch (thrown) {
        return { ok: false, message: thrown instanceof Error ? thrown.name + ': ' + thrown.message : String(thrown) };
      }
    })()`;
    let result;
    try {
      result = await contents.executeJavaScript(wrapped, true);
    } catch (thrown) {
      // Not an expression, or a value that cannot be cloned out of the page.
      throw new Error(`${thrown instanceof Error ? thrown.message : String(thrown)} The expression: ${String(js).slice(0, 300)}`);
    }
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  const calls = {
    eval: (js) => evaluate(String(js)),

    // Polled from here: timers of the main process are never throttled (testing.md 8.5).
    async waitFor(js, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await evaluate(String(js))) return;
        if (Date.now() >= deadline) throw new Error(`waitFor: not truthy after ${timeoutMs} ms: ${js}`);
        await sleep(POLL_MS);
      }
    },

    async capture(file) {
      const image = await contents.capturePage();
      if (image.isEmpty()) throw new Error('capture: the page gave an empty image');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, image.toPNG());
      return file;
    },

    async show() {
      win.showInactive();
    },

    async errors() {
      return [...errors];
    },

    // Not a call of AppDriver: launchApp asks for the folder, to remove what Chromium still writes there while it exits.
    async userData() {
      return app.getPath('userData');
    },
  };

  process.on('message', (message) => {
    if (typeof message !== 'object' || message === null || typeof message.id !== 'number') return;
    const { id, call, args } = message;
    if (call === 'close') {
      // Answered first: the channel goes with the process. The window is destroyed, not asked (the page's own
      // close handling is not what a test waits for).
      process.send({ id, ok: true, value: encode(undefined) }, () => {
        if (!win.isDestroyed()) win.destroy();
        app.quit();
      });
      return;
    }
    const run = Object.hasOwn(calls, call) ? calls[call] : undefined;
    Promise.resolve()
      .then(() => {
        if (!run) throw new Error(`The test driver has no call "${call}"`);
        return run(...(Array.isArray(args) ? args : []));
      })
      .then(
        (value) => process.send({ id, ok: true, value: encode(value) }),
        (thrown) => process.send({ id, ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) }),
      )
      .catch((thrown) => {
        // The value could not be sent: the call still gets its one answer.
        process.send({ id, ok: false, error: `The result could not be sent to the test: ${thrown instanceof Error ? thrown.message : String(thrown)}` });
      });
  });

  process.send({ ready: true });
};
