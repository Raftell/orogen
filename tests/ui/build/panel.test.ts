// The build panel in the application (testing.md 5.6 rule 3): it is mounted, its settings change the project as
// the settings may be changed, and every command it registers runs once. One application, one small project.
//
// Captures, for a person: ui/build/panel-01-settings, panel-02-guide.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { GraphDoc } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, attr, build, buildState, built, capture, chooseFolder, press, quote, ridge, run, scratch, showPanel, showTab, text, texts, vanishes, withBuildPanel, writeProject,
  PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('panel');
const { doc: DOC, ids: IDS } = ridge({ buildResolution: 241 });
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'ridge', DOC);
const OUT = path.join(FOLDER, 'out');

const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
const enabled = (app: AppDriver, command: string): Promise<boolean> =>
  app.eval<boolean>(`(() => { const button = document.querySelector('[data-panel="build"] [data-command="${command}"]'); return button !== null && !button.disabled; })()`);

test('the build panel: its settings, and every command it registers', async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    // ---- 1. as it stands before any build ----
    assert.equal(await text(app, '[data-build="status-line"]'), 'Not built yet');
    assert.equal(await text(app, '[data-build="status-sub"]'), 'Build asks for the output folder');
    assert.deepEqual([await enabled(app, 'build.start'), await enabled(app, 'build.revealFolder'), await enabled(app, 'build.importGuide')], [true, false, true]);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-panel="build"] [data-command="build.cancel"]') === null`), true, 'there is nothing to cancel');
    // The project's own resolution is shown as it is stored, with what it means on the ground.
    assert.equal(await text(app, '#build-resolution .og-select-value'), '241 × 241 (custom)');
    assert.equal(await text(app, '[data-build="spacing"]'), '8.33 m per vertex');
    assert.match((await text(app, '[data-build="layout"]'))!, /^A custom size: whether Unreal has a landscape of it is checked when a build is planned$/);
    assert.equal(await text(app, '[data-build="preview"]'), 'Previews run at 121 × 121');
    // Memory against the budget, from what the shown nodes held.
    assert.match((await text(app, '[data-build="memory"]'))!, /^at least \d+(\.\d)? (KB|MB) of \d+(\.\d+)? (MB|GB)$/);
    assert.equal(await attr(app, '[data-build="memory"]', 'data-level'), 'fits');
    assert.equal(await text(app, '[data-build="memory-field"]'), 'One field at this size is 227 KB');
    // The folder: none yet, and the rules of the pipeline said before a build meets them.
    assert.equal(await text(app, '[data-build="folder-name"]'), 'Not chosen');
    const rules = (await texts(app, '[data-build="folder-rules"] li')).join(' ');
    for (const part of ['replaces everything', 'new, empty, or hold an earlier Orogen build and nothing else', 'Never the folder of the project file', '.partial']) assert.ok(rules.includes(part), part);
    // What a build does to the previews is said in the panel.
    assert.match((await text(app, '[data-build-note="previews"]'))!, /^While a build runs, previews pause and the viewport keeps its last picture\. They resume when the build ends\.$/);
    // Before any plan: the export nodes of the document, each with what feeds it.
    assert.deepEqual(await app.eval<string[][]>(`[...document.querySelectorAll('[data-build-export]')].map((row) => [row.getAttribute('data-build-export'), row.hasAttribute('data-enabled'), row.hasAttribute('data-connected')].map(String))`), [
      [IDS.landscape, 'true', 'true'], [IDS.rock, 'true', 'true'], [IDS.normal, 'true', 'true'],
    ]);
    // Each by what it exports: the layer's name tells it from the next Landscape Layer, the title of its source says what feeds it.
    assert.deepEqual(await texts(app, '[data-build-export]'), ['Unreal LandscapeRidgefrom Mountain RangeSelect', 'Landscape LayerRockfrom SlopeSelect', 'Normal TextureNormalfrom Mountain RangeSelect']);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="known-problems"]') === null`), true, 'the document says nothing against a build');
    t.diagnostic(`capture: ${await capture(app, 'panel-01-settings')}`);

    // A section that is folded stays folded while another panel is in front: the panel's model keeps it, not the component.
    await press(app, '[data-build-section="plan"] > button');
    await vanishes(app, '[data-build="export-nodes"]');
    await showTab(app, 'Inspector');
    await vanishes(app, '[data-panel="build"]');
    await showPanel(app);
    assert.equal(await attr(app, '[data-build-section="plan"] > button', 'aria-expanded'), 'false');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="export-nodes"]') === null`), true);
    await press(app, '[data-build-section="plan"] > button');
    await appears(app, '[data-build="export-nodes"]');

    // ---- 2. the resolution: one of Unreal's sizes, chosen from the list; no undo step (runtime.md 8.5 rule 5) ----
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="1009"]');
    assert.deepEqual(await texts(app, '[data-ui="select-list"] .og-menu-item-label'), ['241 × 241 (custom)', '1009 × 1009', '2017 × 2017', '4033 × 4033', '8129 × 8129']);
    await press(app, '[data-ui="select-list"] [data-value="1009"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 1009`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await app.eval<number[]>(`[orogenTest.ctx.doc.getState().past.length, orogenTest.ctx.doc.getState().future.length]`), [0, 0]);
    assert.equal(await text(app, '[data-build="spacing"]'), '1.98 m per vertex');
    assert.equal(await text(app, '[data-build="layout"]'), '8 × 8 components of 2 × 2 sections, 63 × 63 quads each');
    assert.equal(await text(app, '[data-build="memory-field"]'), 'One field at this size is 3.9 MB');
    // The project's own size stays in the list, so the way back is open; chosen again, it is the project's again.
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="241"]');
    assert.equal((await texts(app, '[data-ui="select-list"] .og-menu-item-label')).length, 5);
    await press(app, '[data-ui="select-list"] [data-value="241"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 241`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '#build-resolution .og-select-value'), '241 × 241 (custom)');
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().doc.settings.previewLevel`), 1);

    // ---- 3. build.chooseFolder ----
    await chooseFolder(app, OUT);
    assert.equal(await text(app, '[data-build="folder-name"]'), 'out');
    assert.match((await text(app, '[data-build="status-sub"]'))!, /^into .*out$/);
    // A dialog that is cancelled changes nothing.
    await run(app, 'build.chooseFolder');
    assert.equal(await text(app, '[data-build="folder"]'), OUT);

    // ---- 4. build.start, by its key: Mod+B ----
    const before = (await buildState(app)).requestId;
    await app.eval(`void shellTest.key('KeyB', { ctrl: true })`);
    const first = await built(app, before);
    assert.equal(first.status, 'ok', JSON.stringify(first.problems));
    assert.equal(first.outDir, OUT);
    assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished');
    for (const file of first.files) assert.ok(fs.existsSync(path.join(OUT, file.path)), file.path);

    // ---- what the pointer and the keyboard find: a tooltip where a meaning is not plain, and every control by its name ----
    const leave = (selector: string): Promise<void> => app.eval<void>(`void (() => {
      const element = shellTest.el(${quote(selector)});
      for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) element.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: !type.endsWith('leave') }));
    })()`);
    const tips: readonly (readonly [string, RegExp])[] = [
      ['label[for="build-resolution"]', /^Vertices per side of the build\. An Unreal landscape is made of components of fixed sizes, so only certain resolutions fit\.$/],
      ['[data-build-section="unreal"] [data-build-copy="scale-z"]', /^Copy Scale Z$/],
      [`[data-build-target="${IDS.rock}"] [data-build-select]`, /^Select this node in the graph$/],
      ['[data-build="panel"] [data-command="build.importGuide"]', /^Unreal Import Guide$/],
    ];
    for (const [selector, said] of tips) {
      await app.eval(`void shellTest.hover(${quote(selector)})`);
      await appears(app, '[data-ui="tooltip"]');
      assert.match((await text(app, '[data-ui="tooltip"]'))!, said, selector);
      await leave(selector);
      await vanishes(app, '[data-ui="tooltip"]');
    }
    // Everything that is pressed is a button the Tab key reaches, and says what it is: by its text, or by a label where it is an icon.
    const controls = await app.eval<{ name: string; reachable: boolean; button: boolean }[]>(`[...document.querySelectorAll('[data-build="panel"] button, [data-build="panel"] [role="combobox"]')].map((control) => ({
      name: (control.getAttribute('aria-label') || control.textContent).trim(),
      reachable: control.disabled || control.tabIndex >= 0,
      button: control.tagName === 'BUTTON',
    }))`);
    assert.ok(controls.length > 30, `${controls.length} controls`);
    assert.deepEqual(controls.filter((control) => control.name === '' || !control.reachable || !control.button), []);
    for (const name of ['Build', 'Show Build Folder', 'Unreal Import Guide', 'Build resolution', 'Copy Scale X', 'Copy Heightmap File', 'Select', 'Settings', 'Copy All']) {
      assert.ok(controls.some((control) => control.name === name || control.name.startsWith(name)), name);
    }

    // ---- 5. build.revealFolder: test mode opens no file manager; the command runs and nothing fails ----
    assert.equal(await enabled(app, 'build.revealFolder'), true);
    await press(app, '[data-build-note="outcome"] ~ * [data-command="build.revealFolder"]');

    // ---- 6. build.copyImportValues: every value of the manifest as text ----
    await app.eval(`void (window.copied = [], navigator.clipboard.writeText = (text) => { window.copied.push(text); return Promise.resolve(); })`);
    await appears(app, '[data-build-row="scale-x"]');
    await press(app, '[data-command="build.copyImportValues"]');
    await app.waitFor(`window.copied.length === 1`, PAGE_BACKSTOP_MS);
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, first.manifest!), 'utf8')) as { landscape: { transform: { scaleCm: { x: number; z: number } } } };
    const copied = (await app.eval<string[]>(`window.copied`))[0]!.split('\n');
    assert.ok(copied.includes(`Scale X\t${JSON.stringify(manifest.landscape.transform.scaleCm.x)}`), copied.join(' | '));
    assert.ok(copied.includes(`Scale Z\t${JSON.stringify(manifest.landscape.transform.scaleCm.z)}`));
    assert.ok(copied.includes(`Heightmap File\t${path.join(OUT, 'RidgeHeight.png')}`));

    // ---- 7. build.importGuide: the import by hand, with this build's values under its steps ----
    await press(app, '[data-build-section="unreal"] [data-command="build.importGuide"]');
    await appears(app, '[data-ui="dialog"][data-dialog="import-guide"]');
    assert.deepEqual(await texts(app, '[data-dialog="import-guide"] h4'), ['1. Before you start', '2. Steps', '3. Importing a rebuilt terrain', '4. Known risks and workarounds']);
    assert.match((await text(app, '[data-dialog="import-guide"] [data-build-note="guide-legend"]'))!, /^Nobody at Orogen has run this procedure in Unreal Engine\./);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-dialog="import-guide"] [data-build-guide="2"] > ol > li').length`), 17);
    // Step 7 holds the scale of this build, with a button that copies each digit.
    assert.equal(
      await attr(app, '[data-dialog="import-guide"] [data-build-guide="2"] > ol > li:nth-child(7) [data-build-row="scale-z"]', 'data-value'),
      JSON.stringify(manifest.landscape.transform.scaleCm.z),
    );
    t.diagnostic(`capture: ${await capture(app, 'panel-02-guide')}`);
    await press(app, '[data-dialog="import-guide"] [data-action="close"]');
    await vanishes(app, '[data-ui="dialog"][data-dialog="import-guide"]');

    // The guide opens from the command whichever panel is in front: here with the inspector over the build panel.
    await showTab(app, 'Inspector');
    await vanishes(app, '[data-panel="build"]');
    await run(app, 'build.importGuide');
    await appears(app, '[data-ui="dialog"][data-dialog="import-guide"]');
    await press(app, '[data-dialog="import-guide"] [data-action="close"]');
    await vanishes(app, '[data-ui="dialog"][data-dialog="import-guide"]');
    await showPanel(app);

    // ---- 8. build.cancel: a build cancelled as it starts writes nothing new, and the build before it stays ----
    const kept = Object.fromEntries(fs.readdirSync(OUT).sort().map((name) => [name, fs.statSync(path.join(OUT, name)).size]));
    await app.eval(`void (window.stopCancel = orogenTest.ctx.engine.subscribe((event) => {
      if (event.type !== 'build-start') return;
      window.stopCancel();
      orogenTest.ctx.run('build.cancel');
    }))`);
    const second = await build(app);
    assert.equal(second.status, 'aborted');
    assert.equal(await text(app, '[data-build="outcome"]'), 'Build cancelled');
    assert.deepEqual(Object.fromEntries(fs.readdirSync(OUT).sort().map((name) => [name, fs.statSync(path.join(OUT, name)).size])), kept);

    // ---- 9. build.selectProblemNode: a plan with an error names its node, and the command selects it ----
    const edge = Object.values((await docOf(app)).edges).find((candidate) => candidate.to.node === IDS.normal)!;
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Disconnect', (draft) => { delete draft.edges[${quote(edge.id)}]; })`);
    assert.equal(await attr(app, `[data-build-export="${IDS.normal}"]`, 'data-connected'), null, 'the list of export nodes says it at once');
    // And so does the panel, before any build is started: at its head, and as the problem a plan will report, with its code and its node.
    assert.deepEqual([await text(app, '[data-build="status-line"]'), await text(app, '[data-build="status-sub"]'), await attr(app, '[data-build="status-line"]', 'data-tone')],
      ['An export node has no input', 'Normal Texture: nothing is connected to its input.', 'warning']);
    assert.equal(
      await text(app, '[data-build="known-problems"] [data-build-problem="E_INPUT_MISSING"]'),
      'An export node has no inputE_INPUT_MISSINGNormal Texture: nothing is connected to its input.Connect the terrain, mask or color map it should export, or switch the node off.Select node',
    );
    await press(app, `[data-build="known-problems"] [data-build-select="${IDS.normal}"]`);
    assert.deepEqual(await app.eval<string[]>(`orogenTest.ctx.ui.getState().selection`), [IDS.normal]);
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);
    const third = await build(app);
    assert.equal(third.status, 'errors');
    assert.equal(await text(app, '[data-build="outcome"]'), 'The build did not start');
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-build="status-sub"]')?.textContent ?? null`), null, 'a build that did not start took no time worth saying');
    assert.match((await text(app, '[data-build="problems"] [data-build-problem="E_INPUT_MISSING"]'))!, /^An export node has no inputE_INPUT_MISSINGNormal Texture: nothing is connected to its input/);
    // The plan of that build says that it is no plan to build by, and still lists what the rest of it would write.
    assert.match((await text(app, '[data-build-note="plan-failed"]'))!, /^This plan has an error, so the build stopped here, before it computed or wrote anything\. Below is what the rest of the plan would write\.$/);
    assert.deepEqual(await texts(app, '[data-build="stages"] li'), [], 'no stage of a build that began none');
    await run(app, 'build.selectProblemNode');
    assert.deepEqual(await app.eval<string[]>(`orogenTest.ctx.ui.getState().selection`), [IDS.normal]);
    // Nothing was written, and the build before the two that failed is still whole.
    assert.deepEqual(Object.fromEntries(fs.readdirSync(OUT).sort().map((name) => [name, fs.statSync(path.join(OUT, name)).size])), kept);

  });
});
