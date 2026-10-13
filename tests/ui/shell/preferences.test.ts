// The preferences in the window (runtime.md 2.4, 8.6): the GPU memory budget is set in the dialog, is in force in
// the engine at once and is in the preferences file, and the other preferences the contract names are reached
// from the same dialog.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Preferences } from '../../../src/platform/electron/ipc.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { appears, capture, docked, exists, key, PAGE_BACKSTOP_MS, press, quote, ready, run, settled, vanishes, withApp } from './rig.ts';

const GIB = 2 ** 30;
const MIB = 2 ** 20;
const stored = (app: AppDriver): Promise<Preferences> => app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
const budget = (app: AppDriver): Promise<number> => app.eval<number>(`orogenTest.ctx.engineState.getState().memory.budgetBytes`);
/** Waits until the engine reports a budget near `bytes`: the session may raise it to what it has reserved (2.4). */
const budgetNear = (app: AppDriver, bytes: number): Promise<void> =>
  app.waitFor(`Math.abs((orogenTest.ctx.engineState.getState().memory?.budgetBytes ?? 0) - ${bytes}) <= ${MIB}`, PAGE_BACKSTOP_MS);

test('preferences: the GPU memory budget is set in the dialog, applied by the engine and stored through the bridge', async (t) => {
  await withApp({}, async (app) => {
    const caps = await ready(app);
    await docked(app);
    await settled(app);
    assert.deepEqual((await stored(app)).gpu, { vramBytes: null, budgetFraction: 0.6 }, 'a first start has the defaults');
    const detected = caps.vramBytes ?? 4 * GIB;
    await budgetNear(app, Math.floor(detected * 0.6));

    // The dialog opens by its key and says what the budget is.
    await key(app, 'Comma', { ctrl: true });
    await appears(app, '[data-dialog="preferences"] [data-tab="graphics"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-value="budget-fraction"]')`), '60 %');
    t.diagnostic(`capture: ${await capture(app, 'preferences-graphics')}`);

    // The share: five steps of the slider's thumb.
    const thumb = '[data-dialog="preferences"] [data-ui="slider"] input[type="range"]';
    for (let step = 0; step < 5; step++) await key(app, 'ArrowRight', {}, thumb);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.budgetFraction === 0.65)`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`shellTest.text('[data-value="budget-fraction"]')`), '65 %');
    await budgetNear(app, Math.floor(detected * 0.65));
    // The slider ends where the contract's range does.
    await key(app, 'End', {}, thumb);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.budgetFraction === 0.85)`, PAGE_BACKSTOP_MS);
    await key(app, 'Home', {}, thumb);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.budgetFraction === 0.3)`, PAGE_BACKSTOP_MS);
    await budgetNear(app, Math.floor(detected * 0.3));

    // The video memory, set by hand: 2 GB, of which 30 % are 614 MB.
    const select = '[data-dialog="preferences"] [data-ui="select"]';
    assert.equal(await exists(app, '[data-dialog="preferences"] [data-ui="number-field"]'), false);
    await press(app, select);
    await appears(app, '[data-ui="select-list"] [data-value="manual"]');
    await press(app, '[data-ui="select-list"] [data-value="manual"]');
    const memory = '[data-dialog="preferences"] [data-ui="number-field"]';
    await appears(app, memory);
    await press(app, memory);
    await appears(app, `${memory} input`);
    await app.eval(`void shellTest.type(${quote(`${memory} input`)}, '2')`);
    await key(app, 'Enter', {}, `${memory} input`);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.vramBytes === ${2 * GIB})`, PAGE_BACKSTOP_MS);
    await budgetNear(app, Math.floor(2 * GIB * 0.3));
    assert.match(await app.eval<string>(`shellTest.text('[data-value="budget"]')`), /^Budget 614 MB of 2\.0 GB/);
    // A typed size may carry its unit.
    await press(app, memory);
    await appears(app, `${memory} input`);
    await app.eval(`void shellTest.type(${quote(`${memory} input`)}, '3072 MB')`);
    await key(app, 'Enter', {}, `${memory} input`);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.vramBytes === ${3 * GIB})`, PAGE_BACKSTOP_MS);

    // Back to what the system reports.
    await press(app, select);
    await appears(app, '[data-ui="select-list"] [data-value="auto"]');
    await press(app, '[data-ui="select-list"] [data-value="auto"]');
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.gpu.vramBytes === null)`, PAGE_BACKSTOP_MS);
    await budgetNear(app, Math.floor(detected * 0.3));
    assert.equal(await budget(app) > 0, true);
    // The project is computed as before: a smaller budget is still enough for one terrain at the preview resolution.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = 2; })`);
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="preferences"]');
    await settled(app);
    assert.equal(await app.eval<number>(`Object.values(orogenTest.ctx.engineState.getState().nodes).filter((node) => node.state === 'error').length`), 0);
  });
});

test('preferences: keys are changed and given back, and the layout and the recent projects are reset from the dialog', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await run(app, 'edit.preferences');
    await appears(app, '[data-dialog="preferences"]');
    await press(app, '[data-tab-button="keys"]');
    await appears(app, '[data-key-of="file.save"]');

    // Every command has a row, with the key in force.
    const rows = await app.eval<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-key-of]')].map((button) => [button.getAttribute('data-key-of'), button.textContent]))`);
    assert.equal(rows['file.save'], 'Ctrl+S');
    assert.equal(rows['edit.redo'], 'Ctrl+Shift+Z');
    assert.equal(rows['file.exit'], 'None');
    assert.equal(rows['build.start'], 'Ctrl+B');
    assert.ok(Object.keys(rows).length >= 20);

    // A new key for a command: its button, then the key.
    await press(app, '[data-key-of="file.save"]');
    await key(app, 'KeyS', { ctrl: true, alt: true }, '[data-key-of="file.save"]');
    await app.waitFor(`shellTest.text('[data-key-of="file.save"]') === 'Ctrl+Alt+S'`, PAGE_BACKSTOP_MS);
    // Escape while a key is awaited changes nothing and leaves the dialog open.
    await press(app, '[data-key-of="file.new"]');
    await key(app, 'Escape', {}, '[data-key-of="file.new"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-key-of="file.new"]')`), 'Ctrl+N');
    assert.equal(await exists(app, '[data-dialog="preferences"]'), true);
    // Backspace leaves a command without a key.
    await press(app, '[data-key-of="engine.togglePause"]');
    await key(app, 'Backspace', {}, '[data-key-of="engine.togglePause"]');
    await app.waitFor(`shellTest.text('[data-key-of="engine.togglePause"]') === 'None'`, PAGE_BACKSTOP_MS);
    // A key that another command has by default is taken from it, and the dialog says so.
    await press(app, '[data-key-of="view.resetLayout"]');
    await key(app, 'KeyB', { ctrl: true }, '[data-key-of="view.resetLayout"]');
    await appears(app, '[data-ui="key-problems"]');
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('[data-ui="key-problems"] li')`), ['Ctrl+B now runs "view.resetLayout" and no longer "build.start"']);
    assert.equal(await app.eval<string>(`shellTest.text('[data-key-of="build.start"]')`), 'None');
    t.diagnostic(`capture: ${await capture(app, 'preferences-keys')}`);
    assert.deepEqual((await stored(app)).keymap, { 'file.save': 'Mod+Alt+S', 'engine.togglePause': '', 'view.resetLayout': 'Mod+B' });

    // One key given back; then all of them.
    await press(app, '[data-reset-key="view.resetLayout"]');
    await vanishes(app, '[data-ui="key-problems"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-key-of="build.start"]')`), 'Ctrl+B');
    await press(app, '[data-tab-button="general"]');
    await appears(app, '[data-action="reset-keys"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-action="reset-keys"]')`), 'Reset 2 to Default');
    await press(app, '[data-action="reset-keys"]');
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => Object.keys(preferences.keymap).length === 0)`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`shellTest.el('[data-action="reset-keys"]').disabled`), true);

    // The recent projects and the layout.
    await app.eval(`void orogenTest.shell.state.setState({ preferences: { ...orogenTest.shell.state.getState().preferences, recent: ['/a.orogen', '/b.orogen'] } })`);
    await app.waitFor(`shellTest.text('[data-dialog="preferences"] [data-command="file.clearRecent"]') === 'Clear 2 Recent'`, PAGE_BACKSTOP_MS);
    await press(app, '[data-dialog="preferences"] [data-command="file.clearRecent"]');
    await app.waitFor(`orogenTest.shell.state.getState().preferences.recent.length === 0`, PAGE_BACKSTOP_MS);
    const resets = await app.eval<number>(`orogenTest.shell.state.getState().layoutResets`);
    await press(app, '[data-dialog="preferences"] [data-command="view.resetLayout"]');
    assert.equal(await app.eval<number>(`orogenTest.shell.state.getState().layoutResets`), resets + 1);
    t.diagnostic(`capture: ${await capture(app, 'preferences-general')}`);
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="preferences"]');
  });
});
