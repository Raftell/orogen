// A small project built from the panel, at 241 and then at 1009 into the same folder: the files on disk are
// those the panel lists, with their sizes, and every number the panel shows for Unreal is the manifest's, digit
// for digit, on screen and on the clipboard.
//
// The task named 253 for the small build. 253 is a landscape size and no build resolution: a build resolution is
// one above a multiple of 16 (engine.md 1.5), and the settings would store 257, which is no landscape. 241 is
// both (15 quads per section, 2 x 2 sections, 8 x 8 components), and is what the export tests build at.
//
// Captures, for a person: ui/build/build-01-plan, build-02-result, build-03-unreal, build-04-report.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { BuildResult } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, attr, build, capture, chooseFolder, dismissNotices, planned, press, ridge, run, scratch, scrollTo, settled, text, texts, vanishes, withBuildPanel, writeProject, PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('builds');
const { doc: DOC, ids: IDS } = ridge({ buildResolution: 241 });
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'ridge', DOC);
const OUT = path.join(FOLDER, 'out');

interface Manifest {
  readonly resolution: { readonly x: number; readonly y: number };
  readonly terrain: { readonly sizeM: number };
  readonly landscape: {
    readonly layout: { readonly quadsPerSection: number; readonly sectionsPerComponent: number; readonly components: { readonly x: number; readonly y: number } };
    readonly heightmap: { readonly png: string };
    readonly transform: Readonly<Record<'scaleCm' | 'actorLocationCm' | 'uiLocationCm', { readonly x: number; readonly y: number; readonly z: number }>>;
    readonly worldPartition: { readonly gridSize: number; readonly regionSize: number };
    readonly alphamapType: string;
    readonly layers: readonly { readonly name: string; readonly png: string; readonly blend: string }[];
  };
  readonly textures: readonly { readonly file: string; readonly srgb: boolean }[];
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
}

/** A number as the manifest's own text holds it: found in the file, not printed again. */
function digits(source: string, value: number): string {
  const written = JSON.stringify(value);
  assert.ok(new RegExp(`[ :\\[]${written.replace(/[.+-]/g, '\\$&')}[,\\s}\\]]`).test(source), `${written} stands in the manifest`);
  return written;
}

/** What the panel must show for a manifest: the value each row copies, by the row's id. Written from the manifest alone. */
function expected(source: string, out: string): Record<string, string> {
  const manifest = JSON.parse(source) as Manifest;
  const { layout, transform, worldPartition, layers } = manifest.landscape;
  const number = (value: number): string => digits(source, value);
  return {
    'heightmap-file': path.join(out, manifest.landscape.heightmap.png),
    'flip-y': 'Off',
    'section-size': number(layout.quadsPerSection),
    'sections': number(layout.sectionsPerComponent),
    'components': number(layout.components.x),
    'resolution': number(manifest.resolution.x),
    'scale-x': number(transform.scaleCm.x), 'scale-y': number(transform.scaleCm.y), 'scale-z': number(transform.scaleCm.z),
    'location-x': number(transform.uiLocationCm.x), 'location-y': number(transform.uiLocationCm.y), 'location-z': number(transform.uiLocationCm.z),
    'rotation': '0, 0, 0',
    ...Object.fromEntries(layers.flatMap((layer, i) => [[`layer-${i}`, layer.name], [`layer-${i}-file`, path.join(out, layer.png)]])),
    'alphamap': manifest.landscape.alphamapType,
    'grid-size': number(worldPartition.gridSize), 'region-size': number(worldPartition.regionSize),
    'actor-x': number(transform.actorLocationCm.x), 'actor-y': number(transform.actorLocationCm.y), 'actor-z': number(transform.actorLocationCm.z),
    ...Object.fromEntries(manifest.textures.map((texture, i) => [`texture-${i}`, path.join(out, texture.file)])),
    'terrain-size': number(manifest.terrain.sizeM),
  };
}

interface Row { readonly id: string; readonly value: string; readonly shown: string; readonly copies: string | null }
const rows = (app: AppDriver): Promise<Row[]> => app.eval<Row[]>(`[...document.querySelectorAll('[data-build-section="unreal"] [data-build-row]')].map((row) => ({
  id: row.getAttribute('data-build-row'),
  value: row.getAttribute('data-value'),
  shown: row.children[1].textContent,
  copies: row.querySelector('[data-build-copy]')?.getAttribute('data-copy-text') ?? null,
}))`);

/** The folder holds the build and nothing else: every file the result names, with its size, and the report. */
function checkFolder(result: BuildResult, out: string): void {
  assert.equal(result.outDir, out);
  const held = fs.readdirSync(out).sort();
  assert.deepEqual(held, [...result.files.map((file) => file.path), result.report!].sort());
  for (const file of result.files) assert.equal(fs.statSync(path.join(out, file.path)).size, file.bytes, file.path);
  assert.equal(fs.existsSync(`${out}.partial`), false, 'nothing is left of the staging folder');
  assert.equal(fs.existsSync(`${out}.previous`), false, 'nor of the build it replaced');
}

/** The panel lists the files of the result with their sizes, and shows for Unreal what the manifest holds. */
async function checkPanel(app: AppDriver, result: BuildResult, out: string): Promise<Record<string, string>> {
  const written = await app.eval<[string, string | null][]>(`[...document.querySelectorAll('[data-build-written]')].map((row) => [row.getAttribute('data-build-written'), row.getAttribute('data-bytes')])`);
  assert.deepEqual(written, [...result.files.map((file): [string, string | null] => [file.path, String(file.bytes)]), [result.report!, null]]);
  assert.equal(await text(app, '[data-build="result-folder"]'), out);

  await appears(app, '[data-build-row="scale-x"]');
  const source = fs.readFileSync(path.join(out, result.manifest!), 'utf8');
  const want = expected(source, out);
  const shown = await rows(app);
  assert.deepEqual(shown.map((row) => row.id), Object.keys(want), 'the rows, in the order of the import');
  for (const row of shown) {
    assert.equal(row.value, want[row.id], row.id);
    // A number is shown as it is copied; a file is shown by its name and copied with its folder; what is chosen, not typed, has no button.
    const typed = /^(scale|location|actor)-[xyz]$|^(grid|region)-size$/.test(row.id);
    if (typed) assert.deepEqual([row.shown, row.copies], [want[row.id], want[row.id]], row.id);
    else if (['flip-y', 'rotation', 'alphamap'].includes(row.id)) assert.deepEqual([row.shown, row.copies], [want[row.id], null], row.id);
    else assert.equal(row.copies, want[row.id], row.id);
  }
  return want;
}

test('a small project built at 241 and at 1009: the files, and the numbers Unreal needs against the manifest', async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    await app.eval(`void (window.copied = [], navigator.clipboard.writeText = (text) => { window.copied.push(text); return Promise.resolve(); })`);
    await chooseFolder(app, OUT);
    assert.equal(fs.existsSync(OUT), false, 'the folder does not exist yet: the build makes it');

    // ---- the build at 241 ----
    const small = await build(app);
    assert.equal(small.status, 'ok', JSON.stringify(small.problems));
    assert.deepEqual(small.files.map((file) => file.path), ['RidgeHeight.png', 'RidgeHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerRock.png', 'LayerRock.r8', 'T_Normal_1024.png', 'Ridge.orogen.json']);
    checkFolder(small, OUT);
    assert.equal(fs.statSync(path.join(OUT, 'RidgeHeight.r16')).size, 2 * 241 * 241);
    assert.equal(fs.statSync(path.join(OUT, 'LayerRock.r8')).size, 241 * 241);

    assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished');
    assert.match((await text(app, '[data-build="status-sub"]'))!, /^in \d+(\.\d)? s$/);
    assert.equal(await text(app, '[data-build="outcome"]'), 'Build finished');
    assert.equal(await attr(app, '[data-build="outcome"]', 'data-status'), 'ok');
    const bytes = small.files.reduce((sum, file) => sum + file.bytes, 0);
    assert.match((await text(app, '[data-build="written"]'))!, /^8 files, \d+(\.\d)? (KB|MB)\. The output folder holds this build and nothing else\.$/);
    assert.equal(await text(app, '[data-build-place="Output folder"]'), `Output folder${OUT}`);
    assert.ok(bytes > 2 * 241 * 241);

    const first = await checkPanel(app, small, OUT);
    // 241 = 8 components of 2 sections of 15 quads, plus one: what the manifest says, and what the panel passes on.
    assert.deepEqual([first['section-size'], first.sections, first.components, first.resolution], ['15', '2', '8', '241']);
    assert.deepEqual(
      (await rows(app)).filter((row) => ['section-size', 'sections', 'components', 'resolution'].includes(row.id)).map((row) => row.shown),
      ['15x15 quads', '2x2', '8 x 8', '241 x 241'],
    );
    // Scale X is the terrain's width in centimetres over the quads: 200000 / 240.
    assert.equal(first['scale-x'], '833.3333333333334');
    assert.deepEqual([first['location-x'], first['location-y'], first['actor-x'], first['actor-y']], ['0', '0', '-100000', '-100000']);
    assert.deepEqual([first['layer-0'], first['layer-1']], ['Base', 'Rock']);
    // A layer says on one line which layer info to create and its method; Unreal's own words for the two stand behind it.
    assert.deepEqual((await rows(app)).filter((row) => /^layer-\d$/.test(row.id)).map((row) => row.shown), ['Weight-Blended, Advanced', 'Weight-Blended, Advanced']);
    assert.equal(await attr(app, '[data-build-section="unreal"] [data-build-row="layer-1"] > span:nth-child(2)', 'title'), 'Weight-Blended Layer, Advanced Weight Blending');
    assert.match((await text(app, '[data-build-group="layers"] > p'))!, /Weight-Blended, Advanced: a Weight-Blended Layer info with the method Advanced Weight Blending\.$/);
    assert.equal((await rows(app)).find((row) => row.id === 'texture-0')!.shown, 'sRGB off');

    // A copy button copies the value with every digit.
    await press(app, '[data-build-section="unreal"] [data-build-copy="scale-z"]');
    await press(app, '[data-build-section="unreal"] [data-build-copy="actor-z"]');
    await press(app, '[data-build-section="unreal"] [data-build-copy="heightmap-file"]');
    await app.waitFor(`window.copied.length === 3`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await app.eval<string[]>(`window.copied`), [first['scale-z'], first['actor-z'], first['heightmap-file']]);
    assert.equal(await attr(app, '[data-build-section="unreal"] [data-build-copy="heightmap-file"]', 'data-copied'), '');
    // A window that may not write to the clipboard (one without the focus may not) copies a selection of its own
    // instead; where that fails as well, the panel says so and marks nothing as copied. Neither reaches the
    // desktop's clipboard from this test: both ways are answered in the page.
    await app.eval(`void (window.selected = [], window.selectionCopies = true, navigator.clipboard.writeText = () => Promise.reject(new Error('The document is not focused')),
      document.execCommand = (command) => { window.selected.push([command, document.querySelector('body > textarea[readonly]')?.value ?? null]); return window.selectionCopies; })`);
    await press(app, '[data-build-section="unreal"] [data-build-copy="scale-x"]');
    await app.waitFor(`window.selected.length === 1`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await app.eval<unknown>(`window.selected`), [['copy', first['scale-x']]]);
    await app.waitFor(`document.querySelector('[data-build-section="unreal"] [data-build-copy="scale-x"]').hasAttribute('data-copied')`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<number>(`document.querySelectorAll('body > textarea').length`), 0, 'what was selected is gone again');
    await app.eval(`void (window.selectionCopies = false)`);
    await press(app, '[data-build-section="unreal"] [data-build-copy="location-z"]');
    await app.waitFor(`[...document.querySelectorAll('[data-ui="notice"]')].some((notice) => notice.textContent.includes('The value could not be copied: select it and copy it by hand'))`, PAGE_BACKSTOP_MS);
    assert.equal(await attr(app, '[data-build-section="unreal"] [data-build-copy="location-z"]', 'data-copied'), null);
    await dismissNotices(app);
    await app.eval(`void (navigator.clipboard.writeText = (text) => { window.copied.push(text); return Promise.resolve(); })`);
    assert.equal(await text(app, '[data-build-section="unreal"] .og-button[data-command="build.importGuide"]'), 'Import Guide');
    assert.match((await text(app, '[data-build="unreal-lead"]'))!, /Nothing here has been run in Unreal Engine/);

    // The plan the build sent: every target with its files, their format and size.
    assert.equal(await text(app, '[data-build-section="plan"] button'), 'Planof the last build');
    assert.deepEqual(await texts(app, '[data-build="plan-targets"] [data-build-file] > span:first-child'), [
      'RidgeHeight.png', 'RidgeHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerRock.png', 'LayerRock.r8', 'T_Normal_1024.png', 'Ridge.orogen.json',
    ]);
    assert.deepEqual(await app.eval<string[]>(`[...document.querySelectorAll('[data-build="plan-targets"] [data-build-target]')].map((target) => target.getAttribute('data-kind') + ':' + target.getAttribute('data-build-target'))`), [
      `landscape:${IDS.landscape}`, 'base:base', `layer:${IDS.rock}`, `texture:${IDS.normal}`, 'manifest:manifest',
    ]);
    assert.deepEqual(await texts(app, '[data-build-file="RidgeHeight.r16"] > span'), ['RidgeHeight.r16', 'Raw, 16-bit', '113 KB']);
    // The one measured figure of memory, from the build's result (export-unreal.md 3.10).
    assert.match((await text(app, '[data-build="peak-pool"]'))!, /^Most held at once, measured\d+(\.\d)? (KB|MB)$/);
    assert.deepEqual(await texts(app, '[data-build-file="RidgeHeight.png"] > span'), ['RidgeHeight.png', 'PNG, 16-bit gray', '—']);
    assert.deepEqual(await texts(app, '[data-build-file="T_Normal_1024.png"] > span'), ['T_Normal_1024.png', 'PNG, 8-bit RGB', '—']);
    assert.equal(await text(app, '[data-build="plan-layout"]'), 'Landscape of 241 × 241: 8 × 8 components of 2 × 2 sections, 15 × 15 quads each');
    assert.match((await text(app, '[data-build="plan-total"]'))!, /^8 files\d+ KB and 5 files sized when written$/);
    // A node of the plan can be selected in the graph.
    await press(app, `[data-build-target="${IDS.rock}"] [data-build-select]`);
    assert.deepEqual(await app.eval<string[]>(`orogenTest.ctx.ui.getState().selection`), [IDS.rock]);
    // The custom size has a layout now: the plan said so.
    assert.equal(await text(app, '[data-build="layout"]'), '8 × 8 components of 2 × 2 sections, 15 × 15 quads each');

    // The report: the time of each stage and each target, and the graphics memory at its height.
    assert.deepEqual(await texts(app, '[data-build="report-stages"] li > span:first-child'), ['Compute the nodes', 'Convert and encode', 'Layer weights', 'Finish the files']);
    assert.equal((await texts(app, '[data-build="report-targets"] li')).length, 3);
    assert.match((await text(app, '[data-build="peak-outputs"]'))!, /^Fields held for later nodes and targets\d+(\.\d)? (KB|MB)$/);
    assert.match((await text(app, '[data-build="peak-node"]'))!, /^Largest working set: (Mountain Range|Slope)\d+(\.\d)? (KB|MB)$/);
    assert.match((await text(app, '[data-build-section="report"] button'))!, /^Report\d+(\.\d)? s in all$/);

    t.diagnostic(`capture: ${await capture(app, 'build-02-result')}`);
    await scrollTo(app, '[data-build-group="scale"]');
    t.diagnostic(`capture: ${await capture(app, 'build-03-unreal')}`);
    await scrollTo(app, '[data-build-section="report"]');
    t.diagnostic(`capture: ${await capture(app, 'build-04-report')}`);
    await scrollTo(app, '[data-build-section="plan"]');
    t.diagnostic(`capture: ${await capture(app, 'build-01-plan')}`);
    await scrollTo(app, '[data-build-section="run"]');

    // ---- the resolution changes: what the panel shows is the last build's, and it says so ----
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="1009"]');
    await press(app, '[data-ui="select-list"] [data-value="1009"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 1009`, PAGE_BACKSTOP_MS);
    // The green of a build that succeeded does not stand over a project it is no longer the build of.
    assert.deepEqual([await text(app, '[data-build="status-line"]'), await text(app, '[data-build="status-sub"]'), await attr(app, '[data-build="status-line"]', 'data-tone')],
      ['Build out of date', 'The project has changed since', 'warning']);
    assert.equal(await text(app, '[data-build="stale"]'), 'The project has changed since this build.');
    assert.match((await text(app, '[data-build-note="unreal-stale"]'))!, /^These are the numbers of the last build, and the project has changed since\. Build again before you import\.$/);
    // The plan of the build was of the project as it was: a moment later the plan of the project as it is stands there,
    // with the sizes of the new resolution.
    await planned(app);
    assert.equal(await attr(app, '[data-build-file="RidgeHeight.r16"] [data-bytes]', 'data-bytes'), String(2 * 1009 * 1009));

    // ---- the build at 1009, into the folder that holds the build at 241 ----
    const before = Object.fromEntries(fs.readdirSync(OUT).map((name) => [name, fs.statSync(path.join(OUT, name)).size]));
    const large = await build(app);
    assert.equal(large.status, 'ok', JSON.stringify(large.problems));
    checkFolder(large, OUT);
    assert.equal(fs.statSync(path.join(OUT, 'RidgeHeight.r16')).size, 2 * 1009 * 1009);
    assert.notEqual(fs.statSync(path.join(OUT, 'RidgeHeight.png')).size, before['RidgeHeight.png'], 'the build at 241 was replaced');
    const second = await checkPanel(app, large, OUT);
    // The rows of Epic's table for 1009, and the scale of 200000 cm over 1008 quads.
    assert.deepEqual([second['section-size'], second.sections, second.components, second.resolution], ['63', '2', '8', '1009']);
    assert.equal(second['scale-x'], '198.4126984126984');
    assert.equal(second['scale-y'], second['scale-x']);
    assert.notEqual(second['scale-z'], first['scale-z'], 'a finer grid measures other extremes');
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-build="stale"]')?.textContent ?? null`), null);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build-note="unreal-stale"]') === null`), true);
    assert.equal(await text(app, '[data-build="plan-layout"]'), 'Landscape of 1009 × 1009: 8 × 8 components of 2 × 2 sections, 63 × 63 quads each');
    assert.deepEqual(await texts(app, '[data-build-file="RidgeHeight.r16"] > span'), ['RidgeHeight.r16', 'Raw, 16-bit', '1.9 MB']);
    t.diagnostic(`at 1009: Scale ${second['scale-x']}, ${second['scale-y']}, ${second['scale-z']}; Location ${second['location-x']}, ${second['location-y']}, ${second['location-z']}`);

    // ---- the engine is restarted: the folder still holds the build, and the panel still shows it ----
    const shown = async (): Promise<(string | null)[]> => [
      await text(app, '[data-build="status-line"]'), await text(app, '[data-build="outcome"]'),
      await attr(app, '[data-build-section="unreal"] [data-build-row="scale-x"]', 'data-value'), await text(app, '[data-build-section="plan"] button'),
    ];
    const beforeRestart = await shown();
    assert.deepEqual(beforeRestart.slice(0, 2), ['Build finished', 'Build finished']);
    await app.eval(`void (window.workerBefore = orogenTest.shell.engineWorker())`);
    await run(app, 'engine.restart');
    await app.waitFor(`orogenTest.shell.engineWorker() !== window.workerBefore && orogenTest.ctx.engineState.getState().device.state === 'ready'`, 60_000);
    assert.deepEqual(await shown(), beforeRestart, 'what the last build wrote and reported is what the panel shows');
    const kept = await app.eval<{ status: string | null; running: boolean; files: number }>(`(() => { const { build } = orogenTest.ctx.engineState.getState(); return { status: build.lastStatus, running: build.running, files: build.result?.files.length ?? 0 }; })()`);
    assert.deepEqual(kept, { status: 'ok', running: false, files: large.files.length });
    assert.equal(await app.eval<boolean>(`!document.querySelector('[data-panel="build"] [data-command="build.revealFolder"]').disabled`), true, 'and its folder can still be shown');
    // The new engine builds as the old one did.
    await settled(app);
    const again = await build(app);
    assert.equal(again.status, 'ok', JSON.stringify(again.problems));
    checkFolder(again, OUT);
  });
});
