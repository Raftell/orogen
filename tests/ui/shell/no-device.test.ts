// An engine that is given no graphics device at all (runtime.md 8.7 rule 16), in the real application: the
// explanation opens by itself, the status bar says "No graphics device" and leads back to it, software rendering
// asks what closing asks and hands the project to the main process, and Retry starts another engine.
//
// The state is forced as the page meets it: an engine worker that never had a device (Restart Engine, 8.8) is
// ended before it can say anything, and what a worker without an adapter posts is posted in its name (8.3 step 1:
// `engine-error`, fatal, "No WebGPU adapter is available"). The main process answers the restart in test mode and
// ends nothing (testing.md 2.9); the relaunch itself is `softwareRelaunchArgs`, held in unit/launch.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NO_ADAPTER } from '../../../src/core/runtime.ts';
import { NO_DEVICE_TEXT, SOFTWARE_RESTART_NOTICE } from '../../../src/app/shell/shell.ts';
import { appears, capture, docked, exists, PAGE_BACKSTOP_MS, press, quote, ready, settled, setSeed, vanishes, withApp } from './rig.ts';

const text = (app: Parameters<typeof ready>[0], selector: string): Promise<string> => app.eval<string>(`shellTest.text(${quote(selector)})`);
const DIALOG = '[data-dialog="no-device"]';

test('no graphics device: the explanation, the status bar, software rendering after the question of unsaved changes, and Retry', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    await setSeed(app, 9);

    // A worker that never had a device, silenced, and the words of one that was given no adapter.
    await app.eval(`(async () => {
      const before = orogenTest.shell.engineWorker();
      await orogenTest.ctx.run('engine.restart');
      const worker = orogenTest.shell.engineWorker();
      if (worker === before) throw new Error('Restart Engine made no worker');
      worker.terminate();
      worker.dispatchEvent(new MessageEvent('message', { data: { event: { type: 'engine-error', message: ${quote(NO_ADAPTER)}, fatal: true } } }));
    })()`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'failed'`, PAGE_BACKSTOP_MS);

    // ---- the explanation opens by itself: what WebGPU needs, what helps, and what software rendering is for ----
    await appears(app, DIALOG);
    assert.equal(await text(app, `${DIALOG} .og-dialog-title`), NO_DEVICE_TEXT.title);
    assert.equal(await text(app, `${DIALOG} [data-text="needs"]`), NO_DEVICE_TEXT.needs);
    assert.match(NO_DEVICE_TEXT.needs, /DirectX 12/);
    assert.equal(await text(app, `${DIALOG} [data-text="software"]`), NO_DEVICE_TEXT.software);
    assert.equal(await text(app, `${DIALOG} [data-text="message"]`), NO_ADAPTER, 'with the engine\'s own words');
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts(${quote(`${DIALOG} .og-dialog-actions button`)})`), ['Restart with Software Rendering', 'Close', 'Retry']);
    t.diagnostic(`capture: ${await capture(app, 'no-device-01-explained')}`);
    await press(app, `${DIALOG} [data-action="close"]`);
    await vanishes(app, DIALOG);

    // ---- the status bar says it, and leads back to the explanation ----
    assert.equal(await text(app, '[data-status="device"]'), 'No graphics deviceRetryDetails…');
    await press(app, '[data-status="device"] [data-action="no-device"]');
    await appears(app, DIALOG);

    // ---- software rendering: the question of closing first; the main process takes the project ----
    await press(app, `${DIALOG} [data-action="software"]`);
    await appears(app, '[data-dialog="unsaved"]');
    assert.equal(await exists(app, DIALOG), false, 'the explanation gave way to the question');
    await press(app, '[data-dialog="unsaved"] [data-action="discard"]');
    await app.waitFor(`shellTest.texts('[data-ui="notice"] .og-notice-text').includes(${quote(SOFTWARE_RESTART_NOTICE)})`, PAGE_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'no-device-02-restarting')}`);
    // In test mode the window stays: this run is still the one on the graphics card's switches.
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.platform.softwareRendering`), false);

    // ---- Retry: another engine, which has the device ----
    await press(app, '[data-status="device"] [data-command="engine.retryDevice"]');
    await ready(app);
    await settled(app);
    assert.equal(await text(app, '[data-status="device"]'), 'Ready');
    assert.equal(await exists(app, DIALOG), false, 'once in a run: a device that is ready opens nothing');
  });
});
