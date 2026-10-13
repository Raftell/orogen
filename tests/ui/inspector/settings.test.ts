// The project settings in the inspector (runtime.md 4.2), which it shows while no node is selected: the size and
// the height range in metres, the sea level, the seed, the build resolution from Unreal's landscape sizes and the
// preview level with the resolution it gives. They are edited with the controls the parameters have, and undone
// like them, except the two resolutions, which are no undo steps (8.5 rule 5).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addNode, setView, type ProjectSettings } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  apart, appears, attrOf, capture, choose, contentKey, count, docOf, enter, exists, inspect, PAGE_BACKSTOP_MS, PANEL, past, press, project, quote, redo,
  scrub, select, setting, settled, textOf, undo, widthOf, withProject,
} from './rig.ts';

const ids = { range: '' };

const FILE = project('settings', (draft, registry) => {
  ids.range = addNode(draft, registry, 'generate/mountain-range', { x: 0, y: 0 });
  setView(draft, { height: { node: ids.range, port: 'out' } });
});

const number = (name: string): string => `${setting(name)} [data-ui="number-field"]`;
const settingsOf = async (app: AppDriver): Promise<ProjectSettings> => (await docOf(app)).settings;
const options = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`shellTest.texts('[data-ui="select-list"] [data-value]')`);
const near = (actual: number, expected: number, what: string, tolerance = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected}`);

test('settings: with nothing selected the inspector edits the project, in metres, with undo', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'settings');
    assert.equal(await textOf(app, `${PANEL} [data-inspector-header]`), 'Project SettingsNo node is selected');
    assert.deepEqual(
      await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PANEL} [data-setting]`)})].map((row) => row.getAttribute('data-setting'))`),
      ['terrainSize', 'heightRange', 'seaLevel', 'seed', 'buildResolution', 'previewLevel'],
    );
    assert.equal(await textOf(app, `${number('terrainSize')} .og-number-value`), '4032 m');
    assert.equal(await textOf(app, `${number('heightRange')} .og-number-value`), '1008 m');
    assert.equal(await textOf(app, '[data-derived="spacing"]'), '4 m in a build of 1009 × 1009');

    // ---- the terrain size: typed in kilometres, one entry, another terrain (the size is in every node's key) ----
    const key0 = await contentKey(app, ids.range);
    await enter(app, number('terrainSize'), '8 km');
    assert.equal((await settingsOf(app)).terrainSize, 8000);
    assert.deepEqual(await past(app), [{ label: 'Project: Terrain size', mergeKey: 'setting:terrainSize' }]);
    assert.equal(await textOf(app, `${number('terrainSize')} .og-number-value`), '8000 m');
    assert.equal(await attrOf(app, setting('terrainSize'), 'data-changed'), '');
    await settled(app);
    assert.notEqual(await contentKey(app, ids.range), key0);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.range)}].cached`), false, 'the node ran for the new size');
    assert.equal(await textOf(app, '[data-derived="spacing"]'), '7.94 m in a build of 1009 × 1009');
    await undo(app);
    assert.equal((await settingsOf(app)).terrainSize, 4032);
    await redo(app);
    assert.equal((await settingsOf(app)).terrainSize, 8000);

    // A drag is one entry; it covers the slider's range in equal ratios and stays inside it.
    await apart();
    const width = await widthOf(app, number('terrainSize'));
    await scrub(app, number('terrainSize'), 30);
    near((await settingsOf(app)).terrainSize, 8000 * (65536 / 256) ** (30 / width), 'a drag on a log scale', 1e-6);
    assert.equal((await past(app)).length, 2);
    await enter(app, number('terrainSize'), '0');
    assert.equal((await settingsOf(app)).terrainSize, 1, 'the least a terrain may be wide (runtime.md 4.2)');
    await enter(app, number('terrainSize'), '2016m');
    assert.equal((await settingsOf(app)).terrainSize, 2016);

    // ---- the height range, and the sea level as a height: a fraction of the range, typed in metres too ----
    await enter(app, number('heightRange'), '2016');
    assert.equal((await settingsOf(app)).heightRange, 2016);
    assert.equal((await past(app)).at(-1)!.label, 'Project: Height range');
    assert.equal(await textOf(app, `${number('seaLevel')} .og-number-secondary`), '0 m');
    await enter(app, number('seaLevel'), '252m');
    near((await settingsOf(app)).seaLevel, 0.125, '252 m of 2016 m', 1e-12);
    assert.equal(await textOf(app, `${number('seaLevel')} .og-number-value`), '0.125');
    assert.equal(await textOf(app, `${number('seaLevel')} .og-number-secondary`), '252 m');
    assert.equal((await past(app)).at(-1)!.label, 'Project: Sea level');
    assert.equal(await textOf(app, '[data-derived="height"]'), '2016 m at height 1, 1764 m above the sea');
    await enter(app, number('seaLevel'), '-1');
    assert.equal((await settingsOf(app)).seaLevel, -1, 'below the terrain: no sea');

    // ---- the seed: typed, and drawn by the dice ----
    const seeded = await contentKey(app, ids.range);
    await enter(app, number('seed'), '7');
    assert.equal((await settingsOf(app)).seed, 7);
    await settled(app);
    assert.notEqual(await contentKey(app, ids.range), seeded, 'a node with a seed has the project seed in its key');
    await apart();
    const steps = (await past(app)).length;
    await press(app, `${setting('seed')} [data-command="inspector.randomizeSeed"]`);
    const drawn = (await settingsOf(app)).seed;
    assert.ok(Number.isInteger(drawn) && drawn !== 7 && drawn >= 0 && drawn <= 2 ** 32 - 1, `seed ${drawn}`);
    assert.deepEqual([(await past(app)).length, (await past(app)).at(-1)!.label], [steps + 1, 'Project: Seed']);
    await settled(app);
    t.diagnostic(`capture: ${await capture(app, 'settings-edited')}`);

    // ---- the reset of a row ----
    await press(app, `${setting('heightRange')} [data-action="reset"]`);
    assert.equal((await settingsOf(app)).heightRange, 1008);
    assert.equal(await exists(app, `${setting('heightRange')} [data-action="reset"]`), false);

    // ---- the help of a setting is the tooltip of its label ----
    await app.eval(`void shellTest.hover(${quote(`${setting('seaLevel')} label`)})`);
    await appears(app, '[data-ui="tooltip"]');
    assert.match(await textOf(app, '[data-ui="tooltip"]'), /^Height at and below which the terrain is sea\./);
  });
});

test('settings: the build resolution is one of Unreal\'s sizes, the preview a level of it; neither is an undo step', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);
    const before = await settingsOf(app);
    assert.deepEqual([before.buildResolution, before.previewLevel], [1009, 1]);
    assert.equal(await textOf(app, `${setting('buildResolution')} .og-select-value`), '1009 × 1009');
    assert.equal(await textOf(app, `${setting('previewLevel')} .og-select-value`), '1/2 · 505 × 505');
    assert.equal((await app.eval<{ resolution: number }>(`orogenTest.ctx.engineState.getState().view`)).resolution, 505);

    // The sizes offered are Unreal's landscape sizes.
    await press(app, `${setting('buildResolution')} [data-ui="select"]`);
    await appears(app, '[data-ui="select-list"] [data-value="8129"]');
    assert.deepEqual(await options(app), ['1009 × 1009', '2017 × 2017', '4033 × 4033', '8129 × 8129']);
    await press(app, '[data-ui="select-list"] [data-value="2017"]');
    await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
    assert.deepEqual([(await settingsOf(app)).buildResolution, (await settingsOf(app)).previewLevel], [2017, 1]);
    assert.deepEqual(await past(app), [], 'the build resolution is no undo step');
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), true, 'but the project has a change to save');
    assert.equal(await textOf(app, '[data-derived="spacing"]'), '2 m in a build of 2017 × 2017');

    // The preview follows: level 1 of 2017 is 1009, which the engine now shows.
    assert.equal(await textOf(app, `${setting('previewLevel')} .og-select-value`), '1/2 · 1009 × 1009');
    await app.waitFor(`orogenTest.ctx.engineState.getState().view?.resolution === 1009`);
    await settled(app);
    const fine = await inspect(app, { node: ids.range, port: 'out' });

    // The levels offered are those of the ladder, each with the resolution it gives.
    await press(app, `${setting('previewLevel')} [data-ui="select"]`);
    await appears(app, '[data-ui="select-list"] [data-value="5"]');
    assert.deepEqual(await options(app), ['Full · 2017 × 2017', '1/2 · 1009 × 1009', '1/4 · 505 × 505', '1/8 · 253 × 253', '1/16 · 127 × 127', '1/32 · 64 × 64']);
    await press(app, '[data-ui="select-list"] [data-value="3"]');
    await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
    assert.equal((await settingsOf(app)).previewLevel, 3);
    assert.deepEqual(await past(app), []);
    await app.waitFor(`orogenTest.ctx.engineState.getState().view?.resolution === 253`);
    await settled(app);
    const coarse = await inspect(app, { node: ids.range, port: 'out' });
    assert.ok(fine !== null && coarse !== null && Math.abs(fine.max - coarse.max) < 0.05, 'the same terrain at a coarser level of the ladder');
    t.diagnostic(`capture: ${await capture(app, 'settings-resolution')}`);

    // A level the next build resolution lacks is lowered to its last (runtime.md 4.2).
    await choose(app, setting('previewLevel'), '5');
    await choose(app, setting('buildResolution'), '1009');
    assert.deepEqual([(await settingsOf(app)).buildResolution, (await settingsOf(app)).previewLevel], [1009, 4]);
    assert.equal(await textOf(app, `${setting('previewLevel')} .og-select-value`), '1/16 · 64 × 64');
    await press(app, `${setting('previewLevel')} [data-ui="select"]`);
    await appears(app, '[data-ui="select-list"] [data-value="4"]');
    assert.equal((await options(app)).length, 5);
    await press(app, '[data-ui="select-list"] [data-value="1"]');
    await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);

    // An undoable change beside them: the undo steps over the resolutions and leaves them as they are.
    await enter(app, number('seed'), '11');
    await choose(app, setting('buildResolution'), '4033');
    await undo(app);
    const after = await settingsOf(app);
    assert.deepEqual([after.seed, after.buildResolution, after.previewLevel], [0, 4033, 1]);
    assert.equal(await count(app, `${setting('buildResolution')}[data-changed]`), 0, '4033 is the default build resolution');
    // The reset of the preview row is the default level.
    await press(app, `${setting('previewLevel')} [data-action="reset"]`);
    assert.equal((await settingsOf(app)).previewLevel, 2);
    await app.waitFor(`orogenTest.ctx.engineState.getState().view?.resolution === 1009`);
    await settled(app);

    // ---- selecting a node shows the node; selecting nothing shows the settings again ----
    await select(app, [ids.range]);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'nodes');
    assert.equal(await exists(app, setting('terrainSize')), false);
    await select(app, []);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'settings');
  });
});
