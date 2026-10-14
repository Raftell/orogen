// The main-process end of the launch check (testing.md 9.1). The application loads this module in test mode
// (OROGEN_TEST=1, OROGEN_TEST_DRIVER=<this file>; testing.md 2.9) once its window has loaded and calls it with
// { app, win, errors }. It watches the engine's device from inside the application, writes what it saw as JSON to
// OROGEN_LAUNCH_CHECK_RESULT and ends the application. launch-check.mjs starts the application and reads the file.
//
// Unlike tests/electron/driver.cjs it needs no channel to a parent: a packaged executable is started as it is.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESULT = process.env.OROGEN_LAUNCH_CHECK_RESULT || '';
/** Backstops, in milliseconds: one call into the page, the device, the first evaluation. */
const CALL_MS = 15_000;
const DEVICE_MS = Number(process.env.OROGEN_LAUNCH_CHECK_DEVICE_MS) || 90_000;
const EVALUATION_MS = Number(process.env.OROGEN_LAUNCH_CHECK_EVALUATION_MS) || 60_000;
const POLL_MS = 100;
const ERRORS_KEPT = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (thrown) => (thrown instanceof Error ? thrown.stack || thrown.message : String(thrown));

/** Rejects when `work` has not settled in time: a page that is gone answers nothing. */
function within(work, ms, what) {
  let timer;
  const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** In the page: every state the device goes through from now on, with the time since the page began. */
const WATCH = `(() => {
  const store = orogenTest.ctx.engineState;
  const seen = (globalThis.__orogenLaunchCheck ??= []);
  const note = () => {
    const device = store.getState().device;
    const last = seen[seen.length - 1];
    if (!last || last.state !== device.state || last.message !== device.message) {
      seen.push({ state: device.state, message: device.message, atMs: Math.round(performance.now()) });
    }
  };
  note();
  store.subscribe(note);
  return true;
})()`;

/** In the page: the device as the status bar would say it, and what was seen of it. */
const DEVICE = `(() => {
  const device = orogenTest.ctx.engineState.getState().device;
  const caps = device.caps;
  return {
    state: device.state,
    message: device.message,
    profile: orogenTest.ctx.platform.gpuProfile,
    adapter: caps ? caps.adapter : null,
    software: caps ? caps.software : null,
    features: caps ? caps.features : null,
    compactFormats: caps ? caps.compactFormats : null,
    vramBytes: caps ? caps.vramBytes ?? null : null,
    seen: globalThis.__orogenLaunchCheck ?? [],
  };
})()`;

/** In the page: how far the first evaluation of the start-up project has come. */
const EVALUATION = `(() => {
  const state = orogenTest.ctx.engineState.getState();
  const counts = {};
  for (const node of Object.values(state.nodes)) counts[node.state] = (counts[node.state] || 0) + 1;
  const errors = Object.values(state.nodes).filter((node) => node.error).map((node) => node.error.kind + ': ' + node.error.message).slice(0, 5);
  return { idle: state.evaluation === null, device: state.device.state, nodes: counts, errors, view: state.view ? { resolution: state.view.resolution, draft: state.view.draft } : null };
})()`;

/** In the page: what an adapter request made now is answered with. */
const LATE_ADAPTER = `(async () => {
  const atMs = Math.round(performance.now());
  if (!navigator.gpu) return { atMs, adapter: null, reason: 'navigator.gpu is missing' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return { atMs, adapter: adapter ? { vendor: adapter.info.vendor, description: adapter.info.description, device: adapter.info.device } : null };
})()`;

module.exports = function launchCheck({ app, win, errors }) {
  const contents = win.webContents;
  const started = Date.now();
  const result = {
    loaded: false,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    environment: { OROGEN_GPU_PROFILE: process.env.OROGEN_GPU_PROFILE ?? null, OROGEN_ELECTRON_GPU: process.env.OROGEN_ELECTRON_GPU ?? null },
    title: null,
    parts: [],
    attempts: [],
    evaluation: null,
    gpuFeatureStatusAtLoad: null,
    gpuFeatureStatus: null,
    gpuDevices: null,
    lateAdapter: null,
    errors: [],
    failure: null,
    elapsedMs: 0,
  };

  const evaluate = (js, ms = CALL_MS) => within(contents.executeJavaScript(js, true), ms, 'the page');

  /** Polls until the device is ready or failed. `after` is how many states had been seen before the wait began. */
  async function device(after) {
    const deadline = Date.now() + DEVICE_MS;
    for (;;) {
      const found = await evaluate(DEVICE);
      const fresh = found.seen.slice(after);
      const settled = fresh.some((entry) => entry.state === 'ready' || entry.state === 'failed');
      if (settled && (found.state === 'ready' || found.state === 'failed')) return found;
      if (Date.now() >= deadline) return { ...found, timedOut: true };
      await sleep(POLL_MS);
    }
  }

  async function gpuStatus() {
    try {
      result.gpuFeatureStatus = app.getGPUFeatureStatus();
      const info = await within(app.getGPUInfo('basic'), 5_000, 'app.getGPUInfo');
      result.gpuDevices = Array.isArray(info?.gpuDevice) ? info.gpuDevice.slice(0, 8) : null;
    } catch (thrown) {
      result.gpuDevices = `not read: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  async function run() {
    if (await evaluate(`typeof orogenTest === 'object' && orogenTest !== null && typeof orogenTest.ctx === 'object'`) !== true) {
      result.failure = 'the page has loaded without its test object (window.orogenTest): the interface did not start';
      return;
    }
    result.loaded = true;
    result.gpuFeatureStatusAtLoad = app.getGPUFeatureStatus();
    result.title = win.getTitle();
    result.parts = await evaluate(`[...document.querySelectorAll('[data-shell], [data-panel]')].map((part) => part.getAttribute('data-shell') ?? 'panel:' + part.getAttribute('data-panel')).slice(0, 40)`);
    await evaluate(WATCH);
    // As tests/electron/kernels.test.ts does: where nothing can present (a virtual display, a runner without a
    // GPU) the first frame drawn to a WebGPU canvas costs the device (runtime.md 7.5 rule 9). This check looks at no pixel.
    await evaluate(`orogenTest.ctx.engine.viewport.detach()`).catch(() => undefined);

    let found = await device(0);
    result.attempts.push(found);
    if (found.state === 'failed') {
      // What the Retry button of the status bar does (runtime.md 8.8 rule 8): said apart, so that a first start
      // without an adapter and a second with one are both on record.
      await gpuStatus();
      result.gpuFeatureStatusAtFailure = result.gpuFeatureStatus;
      await sleep(1_000);
      const before = found.seen.length;
      await evaluate(`orogenTest.ctx.run('engine.retryDevice')`);
      await evaluate(`orogenTest.ctx.engine.viewport.detach()`).catch(() => undefined);
      found = await device(before);
      result.attempts.push(found);
    }
    await gpuStatus();
    if (found.state !== 'ready') return;

    // The start-up project (one Mountain Range, shown) computed on that device: informative, and never a failure
    // of the check, since a software adapter on a shared runner takes as long as it takes.
    const deadline = Date.now() + EVALUATION_MS;
    for (;;) {
      const evaluation = await evaluate(EVALUATION);
      result.evaluation = { ...evaluation, afterMs: Date.now() - started };
      if (evaluation.idle && (evaluation.nodes.done || evaluation.nodes.error) && !evaluation.nodes.running) break;
      if (Date.now() >= deadline) {
        result.evaluation.timedOut = true;
        break;
      }
      await sleep(POLL_MS);
    }
    result.attempts[result.attempts.length - 1] = await evaluate(DEVICE);

    // Whether a page that asks only now is still given an adapter: where Chromium ends up without GPU access
    // after its GPU process failed at start-up, only what asked early has one. An adapter is asked for, no device.
    result.lateAdapter = await evaluate(LATE_ADAPTER).catch((thrown) => ({ error: thrown instanceof Error ? thrown.message : String(thrown) }));
  }

  function finish() {
    result.errors = errors.slice(0, ERRORS_KEPT);
    result.elapsedMs = Date.now() - started;
    let code = 0;
    try {
      if (RESULT === '' || !path.isAbsolute(RESULT)) throw new Error(`OROGEN_LAUNCH_CHECK_RESULT is "${RESULT}"; it is an absolute path`);
      fs.mkdirSync(path.dirname(RESULT), { recursive: true });
      fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
    } catch (thrown) {
      console.error(`[orogen] launch check: the result could not be written: ${messageOf(thrown)}`);
      console.error(JSON.stringify(result));
      code = 4;
    }
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }

  run()
    .catch((thrown) => { result.failure = messageOf(thrown); })
    .then(finish);
};
