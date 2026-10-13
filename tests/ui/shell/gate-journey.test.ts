// The application used as its user uses it, from the first start to a build that Unreal can import, and then a
// project made from nothing. Every step is synthesised input (a press, a drag, a key, typed text): no store is
// written, and no command is run by its id. The stores are read to know what an input did.
//
// Captures, one per step, for a person (testing.md 8.5 rule 1): test-output/ui/gate-journey/NN-*.png.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, serializeDoc, type BuildResult } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  addedNode, appears, attr, boxOf, camera, capture as captureIn, chooseOption, cut, difference, dismissNotices, docOf, drawnShare, EVALUATION_BACKSTOP_MS, focusedPanel,
  graphClick, graphDrag, graphHover, graphSettled, graphWheel, history, inspect, keyPress, nodeBox, OUTPUT, PAGE_BACKSTOP_MS, pageSize, portAt, press, quote, sameField, selection,
  selectNode, settled, showTab, start, text, titleAt, typeInto, vanishes, viewOf,
} from './gate-rig.ts';

const REGISTRY = createRegistry(nodes);
const SHOTS = 'gate-journey';
/** What the journey writes: the project it saves and the two builds. */
const FOLDER = path.join(OUTPUT, 'gate-journey');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });
fs.rmSync(path.join(OUTPUT, 'ui', SHOTS), { recursive: true, force: true });

/** A build at 1009 of a project with simulations, and the preview that follows it. */
const BUILD_BACKSTOP_MS = 240_000;

const capture = (app: AppDriver, name: string): Promise<string> => captureIn(app, SHOTS, name);
const near = (actual: number, expected: number, tolerance: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

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

/** What the build panel must show for Unreal, written from the manifest's own text: a number as the file holds it, not printed again. */
function expectedRows(source: string, out: string): Record<string, string> {
  const manifest = JSON.parse(source) as Manifest;
  const number = (value: number): string => {
    const written = JSON.stringify(value);
    assert.ok(new RegExp(`[ :\\[]${written.replace(/[.+-]/g, '\\$&')}[,\\s}\\]]`).test(source), `${written} stands in the manifest`);
    return written;
  };
  const { layout, transform, worldPartition, layers } = manifest.landscape;
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

const unrealRows = (app: AppDriver): Promise<{ id: string; value: string; shown: string }[]> =>
  app.eval(`[...document.querySelectorAll('[data-build-section="unreal"] [data-build-row]')].map((row) => ({
    id: row.getAttribute('data-build-row'), value: row.getAttribute('data-value'), shown: row.children[1].textContent,
  }))`);

interface BuildState { readonly requestId: number | null; readonly running: boolean; readonly result: BuildResult | null }
const buildState = (app: AppDriver): Promise<BuildState> => app.eval<BuildState>(`(() => {
  const { requestId, running, result } = orogenTest.ctx.engineState.getState().build;
  return { requestId, running, result };
})()`);

/** Presses Build in the panel and waits for the end of that build. */
async function buildFromPanel(app: AppDriver): Promise<BuildResult> {
  const before = (await buildState(app)).requestId;
  await press(app, '[data-panel="build"] [data-command="build.start"]');
  await app.waitFor(`(() => {
    const build = orogenTest.ctx.engineState.getState().build;
    return !build.running && build.result !== null && build.requestId !== ${before === null ? 'null' : before};
  })()`, BUILD_BACKSTOP_MS);
  await app.waitFor(`!document.querySelector('[data-build="status"]').hasAttribute('data-running')`, PAGE_BACKSTOP_MS);
  return (await buildState(app)).result!;
}

/** The picture of the viewport's canvas in a capture. */
async function viewportPicture(app: AppDriver, file: string): Promise<ReturnType<typeof cut>> {
  return cut(file, await boxOf(app, '[data-viewport="canvas"]'), await pageSize(app));
}

test('gate journey: an example is opened, edited, built at 1009 and saved; a second application opens it and shows the same picture', async (t) => {
  const running: AppDriver[] = [];
  const launch = async (): Promise<AppDriver> => {
    const app = await start();
    running.push(app);
    return app;
  };
  const end = async (app: AppDriver): Promise<void> => {
    running.splice(running.indexOf(app), 1);
    await app.close();
  };
  const shot = async (app: AppDriver, name: string): Promise<string> => {
    const file = await capture(app, name);
    t.diagnostic(`capture: ${file}`);
    return file;
  };

  try {
    // ---- 1. start ----
    const first = await launch();
    assert.equal(await text(first, '[data-status="view"]'), '1009 × 1009');
    assert.equal(await focusedPanel(first), 'graph', 'work begins in the graph');
    await shot(first, '01-start');

    // ---- 2. the Examples tab of the library, and the alpine example ----
    await showTab(first, 'Library');
    await press(first, '[data-panel="library"] [data-tab="examples"]');
    await appears(first, '[data-library="examples"][data-place="panel"] [data-example="alpine-range"]');
    await shot(first, '02-examples');
    await press(first, '[data-library="examples"] [data-example="alpine-range"] [data-action="open"]');
    await first.waitFor(`Object.hasOwn(orogenTest.ctx.doc.getState().doc.nodes, 'hydraulic')`, PAGE_BACKSTOP_MS);
    await settled(first);
    await graphSettled(first);
    const alpine = await docOf(first);
    assert.equal(Object.keys(alpine.nodes).length, 21);
    assert.deepEqual(await first.eval<unknown[]>(`(() => { const s = orogenTest.ctx.doc.getState(); return [s.path, s.unsaved, s.past.length, document.title]; })()`), [null, false, 0, 'Untitled - Orogen']);
    assert.deepEqual(await first.eval<string[]>(`Object.entries(orogenTest.ctx.engineState.getState().nodes).filter(([, node]) => node.state === 'error').map(([id]) => id)`), []);
    assert.deepEqual(alpine.ui.view, { height: { node: 'snow', port: 'out' }, overlay: { ref: { node: 'color', port: 'out' }, as: 'color', opacity: 1 } });
    // Fitted, the graph is a quarter of its size and its nodes are blocks of colour: the names of its groups are
    // drawn at the screen's size, so that the overview says what its parts are.
    const groups = await first.eval<{ title: string; height: number; inside: boolean }[]>(`(() => {
      const pane = document.querySelector('[data-graph="root"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-graph="root"] [data-group] [data-role="title"]')].map((title) => {
        const box = title.getBoundingClientRect();
        return { title: title.textContent, height: box.height, inside: box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom };
      });
    })()`);
    assert.deepEqual(groups.map((group) => group.title).sort(), ['Color', 'Erosion', 'Export', 'Layer Masks', 'Shape', 'Snow']);
    for (const group of groups) assert.ok(group.inside && group.height >= 11 && group.height <= 20, `the name of the group ${group.title} can be read: ${JSON.stringify(group)}`);
    await shot(first, '03-alpine-opened');

    // ---- 3. orbit the 3D view ----
    const size = await first.eval<{ width: number; height: number }>(`viewportTest.size()`);
    const orbit = async (): Promise<{ yaw: number; pitch: number }> => {
      const held = await camera(first);
      assert.equal(held.kind, 'orbit');
      return held.kind === 'orbit' ? { yaw: held.yaw, pitch: held.pitch } : { yaw: NaN, pitch: NaN };
    };
    const before = await orbit();
    await first.eval(`void viewportTest.drag([${size.width * 0.5}, ${size.height * 0.5}], [${size.width * 0.5 + 140}, ${size.height * 0.5 - 50}], 0, {}, 12)`);
    const orbited = await orbit();
    assert.ok(Math.abs(orbited.yaw - before.yaw) > 10 && Math.abs(orbited.pitch - before.pitch) > 3, `the drag turned the camera: ${JSON.stringify(before)} to ${JSON.stringify(orbited)}`);
    assert.equal(await focusedPanel(first), 'viewport', 'the panel that was pressed has the focus');
    await shot(first, '04-orbited');

    // ---- 4. the erosion node, and one of its parameters scrubbed in the inspector ----
    // The whole graph fits its panel at a quarter of its size, where a node is a block of its category's colour:
    // the wheel over the erosion nodes brings them near enough to read.
    assert.equal(await first.eval<string>(`graphTest.lod()`), 'far');
    const block = await nodeBox(first, 'hydraulic');
    const over = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
    await graphHover(first, over);
    for (let tick = 0; tick < 12 && (await first.eval<string>(`graphTest.lod()`)) !== 'near'; tick++) await graphWheel(first, over, -120);
    assert.equal(await first.eval<string>(`graphTest.lod()`), 'near');
    await graphSettled(first);
    assert.equal(await text(first, '[data-node="hydraulic"] [data-role="title"]'), 'Gullies and Fans');
    await first.waitFor(`document.querySelector('[data-node="hydraulic"] [data-thumbnail="drawn"]') !== null`, EVALUATION_BACKSTOP_MS);
    await shot(first, '05-graph-zoomed');
    await selectNode(first, 'hydraulic');
    assert.equal(await focusedPanel(first), 'graph');
    await settled(first);
    const erosion = { node: 'hydraulic', port: 'out' };
    assert.deepEqual((await docOf(first)).ui.view?.height, erosion, 'the selected terrain is the terrain shown (7.4)');
    await showTab(first, 'Inspector');
    await appears(first, '[data-panel="inspector"] [data-inspector="nodes"] [data-param="rain"]');
    assert.equal(await first.eval<string>(`document.querySelector('[data-panel="inspector"] [aria-label="Node title"]').value`), 'Gullies and Fans');
    const eroded = await inspect(first, erosion);
    const rain = '[data-panel="inspector"] [data-param="rain"] [data-ui="number-field"]';
    const rainBefore = (await docOf(first)).nodes.hydraulic!.params.rain as number;
    await shot(first, '06-erosion-selected');
    // The button goes down and the pointer moves: the document is in a gesture, and the engine answers with a draft.
    await first.eval(`void shellTest.drag(${quote(rain)}, 60, {}, 8, false)`);
    assert.equal(await first.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), 'param:hydraulic:rain');
    await first.waitFor(`orogenTest.ctx.engineState.getState().view?.draft === true`, EVALUATION_BACKSTOP_MS);
    const draft = (await viewOf(first))!;
    assert.ok(draft.resolution < 1009, `a draft is coarser than the preview: ${draft.resolution}`);
    await first.waitFor(`document.querySelector('[data-viewport="state"]')?.textContent === 'Draft'`, PAGE_BACKSTOP_MS);
    await shot(first, '07-scrubbing-draft');
    // Let go: one history entry, and the view is refined to the preview resolution.
    await first.eval(`void shellTest.release(${quote(rain)})`);
    assert.equal(await first.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), null);
    await settled(first);
    const refined = (await viewOf(first))!;
    assert.deepEqual([refined.draft, refined.resolution], [false, 1009]);
    const rainAfter = (await docOf(first)).nodes.hydraulic!.params.rain as number;
    assert.ok(rainAfter > rainBefore, `the drag to the right raised the rain: ${rainBefore} to ${rainAfter}`);
    assert.deepEqual(await history(first), ['Gullies and Fans: Rain']);
    const wetter = await inspect(first, erosion);
    assert.ok(!sameField(wetter, eroded), `more rain is another terrain: ${JSON.stringify(wetter)} after ${JSON.stringify(eroded)}`);
    await first.waitFor(`!document.querySelector('[data-viewport="state"]')`, PAGE_BACKSTOP_MS);
    await shot(first, '08-refined');

    // ---- 5. undo ----
    await keyPress(first, 'KeyZ', { ctrl: true });
    assert.equal((await docOf(first)).nodes.hydraulic!.params.rain, rainBefore);
    await settled(first);
    assert.ok(sameField(await inspect(first, erosion), eroded), 'undo shows the terrain of before the drag');
    assert.deepEqual(await history(first), []);
    await shot(first, '09-undone');

    // ---- 6. a node from the library, found by a search, and connected by dragging ----
    await showTab(first, 'Library');
    await press(first, '[data-panel="library"] [data-tab="nodes"]');
    await appears(first, '[data-library="search"]');
    await press(first, '[data-library="search"]');
    await typeInto(first, '[data-library="search"]', 'terrac');
    await first.waitFor(`document.querySelector('[data-library="list"] [role="option"][aria-selected="true"]')?.getAttribute('data-node') === 'surface/terraces'`, PAGE_BACKSTOP_MS);
    await shot(first, '10-library-search');
    const beforeAdd = await docOf(first);
    await keyPress(first, 'Enter', {}, '[data-library="search"]');
    const terraces = await addedNode(first, beforeAdd);
    assert.equal((await docOf(first)).nodes[terraces]!.type, 'surface/terraces');
    assert.deepEqual(await selection(first), [terraces], 'the node that was added is selected');
    assert.deepEqual(await history(first), ['Add Terraces']);
    // The new node lies in the middle of the graph's panel: it is taken to a free place below the chain, and wired.
    const graph = await boxOf(first, '[data-graph="root"]');
    const grip = await titleAt(first, terraces);
    await graphDrag(first, grip, { x: graph.x + graph.width * 0.36, y: graph.y + graph.height * 0.82 });
    assert.deepEqual(await history(first), ['Add Terraces', 'Move']);
    await graphDrag(first, await portAt(first, 'hydraulic', 'out', 'out'), await portAt(first, terraces, 'in', 'in'));
    const wired = await docOf(first);
    assert.ok(Object.values(wired.edges).some((edge) => edge.from.node === 'hydraulic' && edge.from.port === 'out' && edge.to.node === terraces && edge.to.port === 'in'), 'the drag from port to port made the wire');
    assert.deepEqual(await history(first), ['Add Terraces', 'Move', 'Connect']);
    await settled(first);
    const stepped = { node: terraces, port: 'out' };
    assert.deepEqual((await docOf(first)).ui.view?.height, stepped, 'the selected node, now a terrain, is shown');
    assert.ok(!sameField(await inspect(first, stepped), eroded), 'terraces are another terrain');
    await first.waitFor(`['done', 'cached'].includes(document.querySelector('[data-node="${terraces}"]')?.getAttribute('data-status'))`, PAGE_BACKSTOP_MS);
    await shot(first, '11-node-added-and-connected');

    // ---- 7. the natural colour, draped over the terrain that is shown ----
    // The colour nodes lie above and to the right of what the panel shows: the middle button drags the graph there.
    const away = await nodeBox(first, 'color');
    const pane = await boxOf(first, '[data-graph="root"]');
    const grab = { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.72 };
    await graphDrag(first, grab, { x: grab.x + (pane.x + pane.width * 0.5 - (away.x + away.width / 2)), y: grab.y + (pane.y + pane.height * 0.45 - (away.y + away.height / 2)) }, { button: 1 });
    await graphSettled(first);
    const inView = await nodeBox(first, 'color');
    assert.ok(inView.x > pane.x && inView.y > pane.y && inView.x + inView.width < pane.x + pane.width && inView.y + inView.height < pane.y + pane.height, 'the pan brought the colour node into the panel');
    assert.deepEqual(await history(first), ['Add Terraces', 'Move', 'Connect'], 'panning is no step of the history');
    await selectNode(first, 'color');
    await settled(first);
    assert.deepEqual((await docOf(first)).ui.view, { height: stepped, overlay: { ref: { node: 'color', port: 'out' }, as: 'color', opacity: 1 } });
    assert.equal(await attr(first, '[data-viewport="overlay"]', 'data-active'), '', 'the toolbar marks the overlay');
    await shot(first, '12-color-draped');

    // ---- 8. the view from above ----
    await press(first, '[data-viewport="toolbar"] [data-view="top"]');
    await first.waitFor(`viewportTest.attr('data-mode') === 'top'`, PAGE_BACKSTOP_MS);
    await shot(first, '13-top-view');

    // ---- 9. the build panel: 1009, a folder, Build ----
    await showTab(first, 'Build');
    await appears(first, '[data-panel="build"] [data-build="panel"]');
    await shot(first, '14-build-panel');
    await chooseOption(first, '#build-resolution', '1009');
    assert.equal((await docOf(first)).settings.buildResolution, 1009);
    assert.deepEqual(await history(first), ['Add Terraces', 'Move', 'Connect'], 'the build resolution is no undo step');
    const out = path.join(FOLDER, 'alpine-build');
    await first.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)})`);
    await press(first, '[data-panel="build"] [data-command="build.chooseFolder"]');
    await first.waitFor(`document.querySelector('[data-build="folder"]')?.textContent === ${quote(out)}`, PAGE_BACKSTOP_MS);
    await settled(first);
    await shot(first, '15-build-ready');
    const result = await buildFromPanel(first);
    assert.equal(result.status, 'ok', JSON.stringify(result.problems));
    assert.equal(result.outDir, out);
    await dismissNotices(first);
    await shot(first, '16-build-finished');

    // ---- 10. the numbers Unreal needs, against the manifest on disk ----
    const held = fs.readdirSync(out).sort();
    assert.deepEqual(held, [...result.files.map((file) => file.path), result.report!].sort(), 'the folder holds the build and nothing else');
    for (const file of result.files) assert.equal(fs.statSync(path.join(out, file.path)).size, file.bytes, file.path);
    assert.equal(fs.statSync(path.join(out, 'AlpineHeight.r16')).size, 2 * 1009 * 1009);
    const source = fs.readFileSync(path.join(out, result.manifest!), 'utf8');
    const want = expectedRows(source, out);
    await appears(first, '[data-build-row="scale-x"]');
    const shown = await unrealRows(first);
    assert.deepEqual(shown.map((row) => row.id), Object.keys(want), 'the rows, in the order of the import');
    for (const row of shown) assert.equal(row.value, want[row.id], row.id);
    for (const id of ['scale-x', 'scale-y', 'scale-z', 'location-x', 'location-y', 'location-z']) {
      assert.equal(shown.find((row) => row.id === id)!.shown, want[id], `${id} is shown digit for digit`);
    }
    assert.deepEqual([want['section-size'], want.sections, want.components, want.resolution], ['63', '2', '8', '1009']);
    t.diagnostic(`Unreal: Scale ${want['scale-x']}, ${want['scale-y']}, ${want['scale-z']}; Location ${want['location-x']}, ${want['location-y']}, ${want['location-z']}; ${Object.keys(want).filter((id) => /^layer-\d+$/.test(id)).length} layers`);
    await first.eval(`void document.querySelector('[data-build-section="unreal"]').scrollIntoView({ block: 'start' })`);
    await shot(first, '17-unreal-numbers');

    // ---- 11. save; a second application opens the file and shows the same picture ----
    const file = path.join(FOLDER, 'alpine.orogen');
    assert.equal(await first.eval<string>(`document.title`), 'Untitled* - Orogen');
    await first.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    await keyPress(first, 'KeyS', { ctrl: true });
    await first.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)} && orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(await first.eval<string>(`document.title`), 'alpine - Orogen');
    const saved = fs.readFileSync(file, 'utf8');
    assert.ok(saved === serializeDoc(await docOf(first)), 'the file holds the document');
    assert.deepEqual(parseDoc(saved, REGISTRY).problems, []);
    await settled(first);
    const firstShown = await shot(first, '18-saved');

    const second = await launch();
    await second.eval(`void orogenTest.shell.answers.openProjectDialog.push(${quote(file)})`);
    await keyPress(second, 'KeyO', { ctrl: true });
    await second.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    await settled(second);
    await graphSettled(second);
    assert.ok(serializeDoc(await docOf(second)) === saved, 'the second application holds the document the first saved');
    assert.equal(await second.eval<string>(`document.title`), 'alpine - Orogen');
    // The same fields: the terrain and the colour over it, computed by another engine.
    assert.ok(sameField(await inspect(second, stepped), await inspect(first, stepped)), 'the same terrain');
    assert.deepEqual((await viewOf(second))!.resolution, (await viewOf(first))!.resolution);
    // A colour map has no statistics to ask for: that it is the same is seen in the picture, which it covers.
    // And the same picture: both from above, where the camera is the terrain's own frame.
    await keyPress(second, 'F6');
    await second.waitFor(`viewportTest.attr('data-mode') === 'top'`, PAGE_BACKSTOP_MS);
    const secondShown = await shot(second, '19-second-application');
    const [a, b] = [await viewportPicture(first, firstShown), await viewportPicture(second, secondShown)];
    assert.ok(drawnShare(a) > 0.3, `the first application shows a terrain: ${drawnShare(a)}`);
    const apart = difference(a, b);
    t.diagnostic(`the two pictures of the viewport: mean difference ${apart.mean.toFixed(3)} of 255, worst ${apart.worst}, ${(apart.differing * 100).toFixed(2)} % of the values differ by more than 8`);
    assert.ok(apart.mean < 1 && apart.differing < 0.01, `the second application shows the picture of the first: ${JSON.stringify(apart)}`);

    await end(first);
    await end(second);
  } finally {
    for (const app of running.splice(0)) await app.close().catch(() => {});
  }
});

const PALETTE = '[data-graph="palette"]';

/** Types into the graph's palette and waits until the list has the node type in front. */
async function searchPalette(app: AppDriver, query: string, first: string): Promise<void> {
  await appears(app, `${PALETTE} input`);
  await typeInto(app, `${PALETTE} input`, query);
  await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === ${quote(first)}`, PAGE_BACKSTOP_MS);
}

test('gate journey: a project made from nothing by hand, three nodes from the palette to an export, and built', async (t) => {
  const app = await start();
  const shot = async (name: string): Promise<string> => {
    const file = await capture(app, name);
    t.diagnostic(`capture: ${file}`);
    return file;
  };
  try {
    // ---- a new project (File > New, by its key), and its one node deleted: nothing is left ----
    await keyPress(app, 'KeyN', { ctrl: true });
    await settled(app);
    const pane = await boxOf(app, '[data-graph="root"]');
    const middle = { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.5 };
    await graphClick(app, { x: pane.x + pane.width - 60, y: pane.y + pane.height - 40 });
    assert.equal(await focusedPanel(app), 'graph');
    await keyPress(app, 'KeyA', { ctrl: true });
    assert.equal((await selection(app)).length, 1);
    await keyPress(app, 'Delete');
    assert.deepEqual(Object.keys((await docOf(app)).nodes), []);
    await appears(app, '[data-graph="empty"]');
    await app.waitFor(`document.querySelector('[data-viewport="cover"]') !== null`, PAGE_BACKSTOP_MS);
    await shot('20-empty-project');

    // ---- the first node: Tab where the pointer is, a few letters, Enter ----
    const at = { x: pane.x + pane.width * 0.2, y: middle.y };
    await graphHover(app, at);
    await keyPress(app, 'Tab');
    await searchPalette(app, 'mountain', 'generate/mountain');
    await shot('21-palette');
    let before = await docOf(app);
    await keyPress(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const mountain = await addedNode(app, before);
    assert.equal((await docOf(app)).nodes[mountain]!.type, 'generate/mountain');
    assert.deepEqual(await selection(app), [mountain]);
    await settled(app);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: mountain, port: 'out' } }, 'the first terrain of the project is shown');
    const peak = await inspect(app, { node: mountain, port: 'out' });
    assert.ok(peak !== null && peak.max - peak.min > 0.2, `a mountain: ${JSON.stringify(peak)}`);

    // ---- the second: a wire pulled out of the mountain and let go over the canvas opens the palette for it ----
    const out = await portAt(app, mountain, 'out', 'out');
    const drop = { x: out.x + 150, y: out.y + 10 };
    await graphDrag(app, out, drop);
    await searchPalette(app, 'hydraulic', 'simulate/hydraulic-erosion');
    await shot('22-palette-for-a-wire');
    before = await docOf(app);
    await keyPress(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const erosion = await addedNode(app, before);
    let doc = await docOf(app);
    assert.ok(Object.values(doc.edges).some((edge) => edge.from.node === mountain && edge.to.node === erosion && edge.to.port === 'in'), 'the new node is wired to the mountain');
    await settled(app, BUILD_BACKSTOP_MS);
    assert.deepEqual(doc.ui.view === undefined ? null : (await docOf(app)).ui.view?.height, { node: erosion, port: 'out' });
    assert.ok(!sameField(await inspect(app, { node: erosion, port: 'out' }), peak), 'the eroded mountain is another terrain');

    // ---- the third: the export, from the palette, and a wire dragged to it from port to port ----
    const erosionBox = await nodeBox(app, erosion);
    const place = { x: erosionBox.x + erosionBox.width + 200, y: erosionBox.y + erosionBox.height / 2 };
    await graphHover(app, place);
    await keyPress(app, 'Tab');
    await searchPalette(app, 'unreal land', 'io/export-landscape');
    before = await docOf(app);
    await keyPress(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const landscape = await addedNode(app, before);
    assert.equal(await attr(app, `[data-node="${landscape}"]`, 'data-status'), 'missing', 'unwired, the export says what it lacks');
    await shot('23-export-unwired');
    await graphDrag(app, await portAt(app, erosion, 'out', 'out'), await portAt(app, landscape, 'in', 'in'));
    doc = await docOf(app);
    assert.equal(Object.keys(doc.nodes).length, 3);
    assert.ok(Object.values(doc.edges).some((edge) => edge.from.node === erosion && edge.to.node === landscape), 'the erosion feeds the export');
    assert.deepEqual(await history(app), ['Delete', 'Add Mountain', 'Add Hydraulic Erosion', 'Add Unreal Landscape', 'Connect']);
    await settled(app, BUILD_BACKSTOP_MS);
    await app.waitFor(`document.querySelector('[data-node="${landscape}"]').getAttribute('data-status') !== 'missing'`, PAGE_BACKSTOP_MS);
    // The three nodes are the three of the First Terrain example, made by hand; the terrain shown is the eroded one.
    await selectNode(app, erosion);
    await settled(app, BUILD_BACKSTOP_MS);
    await shot('24-three-nodes');

    // ---- the inspector names the export; the build panel builds it ----
    await selectNode(app, landscape);
    await showTab(app, 'Inspector');
    await appears(app, '[data-panel="inspector"] [data-param="name"]');
    await showTab(app, 'Build');
    await appears(app, '[data-panel="build"] [data-build="panel"]');
    // 253, which the task names, is a preview level and no build resolution (engine.md 1.5: one above a multiple of
    // 16). The smallest size the application offers is 1009; the project's previews then run at 253.
    await chooseOption(app, '#build-resolution', '1009');
    assert.equal(await text(app, '[data-build="preview"]'), 'Previews run at 253 × 253');
    const out2 = path.join(FOLDER, 'by-hand-build');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out2)})`);
    // Ctrl+B without a folder asks for one, and builds into it.
    await keyPress(app, 'KeyB', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.result?.outDir === ${quote(out2)} && !orogenTest.ctx.engineState.getState().build.running`, BUILD_BACKSTOP_MS);
    await app.waitFor(`!document.querySelector('[data-build="status"]').hasAttribute('data-running')`, PAGE_BACKSTOP_MS);
    const result = (await buildState(app)).result!;
    assert.equal(result.status, 'ok', JSON.stringify(result.problems));
    const source = fs.readFileSync(path.join(out2, result.manifest!), 'utf8');
    const manifest = JSON.parse(source) as Manifest;
    assert.deepEqual([manifest.resolution.x, manifest.resolution.y], [1009, 1009]);
    assert.equal(fs.statSync(path.join(out2, manifest.landscape.heightmap.png.replace(/\.png$/, '.r16'))).size, 2 * 1009 * 1009);
    for (const file of result.files) assert.equal(fs.statSync(path.join(out2, file.path)).size, file.bytes, file.path);
    const want = expectedRows(source, out2);
    await appears(app, '[data-build-row="scale-x"]');
    for (const row of await unrealRows(app)) assert.equal(row.value, want[row.id], row.id);
    await dismissNotices(app);
    await settled(app, BUILD_BACKSTOP_MS);
    await shot('25-built');
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});
