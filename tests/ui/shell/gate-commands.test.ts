// Every command of the menus that panels fill, chosen in the menu bar of the whole application, and every
// default key of runtime.md 8.8, pressed where its scope is and where it is not. The File and Edit menus are
// held to their effects by commands.test.ts; here are View, Engine and the four menus the panels name.
//
// A menu item is pressed and a key is sent as input; what each did is read from the page.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import {
  addNode, connect, createRegistry, newDoc, serializeDoc, setGroup, setParam, setSettings, setView, type DocDraft, type GraphDoc,
} from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, attr, boxOf, camera, capture as captureIn, closeMenu, docOf, EVALUATION_BACKSTOP_MS, focusedPanel, graphClick, graphSettled, history, keyPress, openMenu, OUTPUT,
  PAGE_BACKSTOP_MS, press, quote, ROOT, selection, selectNode, settled, showTab, start, text, titleAt, typeInto, vanishes,
} from './gate-rig.ts';

const REGISTRY = createRegistry(nodes);
const SHOTS = 'gate-commands';
const FOLDER = path.join(OUTPUT, 'gate-commands');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });
fs.rmSync(path.join(OUTPUT, 'ui', SHOTS), { recursive: true, force: true });
const capture = (app: AppDriver, name: string): Promise<string> => captureIn(app, SHOTS, name);

const PALETTE = '[data-graph="palette"]';
const INSPECTOR = '[data-panel="inspector"]';
const ids = { range: '', blur: '', slope: '', noise: '', landscape: '', imported: '', group: '' };

/**
 * A small project with something for every command to act on: a terrain, a filter, a mask, a node whose
 * parameters are in sections, an export, an import of a file, and a group.
 */
function project(name: string, settings: { readonly buildResolution?: number } = {}): string {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { buildResolution: settings.buildResolution ?? 1009, previewLevel: 1 });
  ids.range = addNode(draft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 });
  ids.blur = addNode(draft, REGISTRY, 'filter/blur', { x: 300, y: 0 });
  ids.slope = addNode(draft, REGISTRY, 'select/slope', { x: 600, y: 180 });
  ids.noise = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 220 });
  ids.landscape = addNode(draft, REGISTRY, 'io/export-landscape', { x: 600, y: 0 });
  ids.imported = addNode(draft, REGISTRY, 'io/import-field', { x: 300, y: 260 });
  setParam(draft, REGISTRY, ids.imported, 'file', path.join(ROOT, 'tests/graphs/assets/heights-253.png'));
  connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.blur, port: 'in' });
  connect(draft, REGISTRY, { node: ids.blur, port: 'out' }, { node: ids.slope, port: 'in' });
  connect(draft, REGISTRY, { node: ids.blur, port: 'out' }, { node: ids.landscape, port: 'in' });
  ids.group = 'shape';
  setGroup(draft, { id: ids.group, title: 'Shape', color: '#79461d', rect: { x: -30, y: -50, w: 580, h: 240 } });
  setView(draft, { height: { node: ids.blur, port: 'out' } });
  const file = path.join(FOLDER, `${name}.orogen`);
  fs.writeFileSync(file, serializeDoc(draft as GraphDoc));
  return file;
}

/** Chooses an item of a menu of the menu bar: a press on the menu, a press on the item. Fails when the item cannot be chosen. */
async function choose(app: AppDriver, menu: string, id: string): Promise<void> {
  const items = await openMenu(app, menu);
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `${menu} has the item ${id}: ${items.map((entry) => entry.id).join(', ')}`);
  assert.equal(item.enabled, true, `${menu} > ${id} can be chosen`);
  await press(app, `[data-ui="menu"][data-menu="${menu}"] [data-item="${id}"]`);
  await vanishes(app, `[data-ui="menu"][data-menu="${menu}"]`);
}

/** Whether an item of a menu can be chosen; the menu is closed again. */
async function enabledIn(app: AppDriver, menu: string, id: string): Promise<boolean> {
  const item = (await openMenu(app, menu)).find((entry) => entry.id === id);
  await closeMenu(app);
  assert.ok(item, `${menu} has the item ${id}`);
  return item.enabled;
}

/** The commands that failed since the application started: the shell says each in the notification area. */
const failures = (app: AppDriver): Promise<string[]> =>
  app.eval<string[]>(`orogenTest.shell.state.getState().log.filter((entry) => entry.level === 'error').map((entry) => entry.message)`);

const paused = (app: AppDriver): Promise<boolean> => app.eval<boolean>(`orogenTest.shell.state.getState().paused`);
const mode = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`viewportTest.attr('data-mode')`);
const viewOf = async (app: AppDriver): Promise<NonNullable<GraphDoc['ui']['view']>> => (await docOf(app)).ui.view ?? {};
const nodeOf = async (app: AppDriver, id: string): Promise<GraphDoc['nodes'][string]> => (await docOf(app)).nodes[id]!;
const focusGraph = async (app: AppDriver): Promise<void> => {
  const pane = await boxOf(app, '[data-graph="root"]');
  await graphClick(app, { x: pane.x + pane.width - 30, y: pane.y + pane.height - 20 });
};
/** A press on the viewport's canvas that moves nothing: the panel has the focus. */
const focusViewport = (app: AppDriver): Promise<void> => app.eval<void>(`void (viewportTest.drag([40, 40], [40, 40], 0, {}, 1), document.querySelector('[data-panel="viewport"]').focus())`);
const orbitOf = async (app: AppDriver): Promise<{ yaw: number; pitch: number; distance: number }> => {
  const held = await camera(app);
  assert.equal(held.kind, 'orbit');
  return held.kind === 'orbit' ? { yaw: held.yaw, pitch: held.pitch, distance: held.distance } : { yaw: NaN, pitch: NaN, distance: NaN };
};
type Orbit = { yaw: number; pitch: number; distance: number };
/** A key on the canvas, and the camera before and after it, read in one turn of the page: nothing else moves it between the two. */
const canvasKey = async (app: AppDriver, code: string): Promise<[Orbit, Orbit]> => {
  const [before, after] = await app.eval<[Orbit & { kind: string }, Orbit & { kind: string }]>(
    `(() => { const before = viewportTest.camera(); shellTest.key(${quote(code)}, {}, '[data-viewport="canvas"]'); return [before, viewportTest.camera()]; })()`);
  assert.ok(before.kind === 'orbit' && after.kind === 'orbit');
  return [before, after];
};
const toolbarValue = (app: AppDriver, label: string): Promise<string | null> => app.eval<string | null>(`document.querySelector('[data-viewport="toolbar"] [aria-label="${label}"]')?.textContent ?? null`);
const numberOf = (app: AppDriver, selector: string): Promise<number> => app.eval<number>(`Number(document.querySelector(${quote(selector)}).getAttribute('data-value'))`);

test('gate: every item of the View, Engine, Viewport, Graph, Inspector and Library menus does what it says', async (t) => {
  const app = await start({ open: project('menus') });
  try {
    await app.waitFor(`orogenTest.ctx.doc.getState().path !== null`, PAGE_BACKSTOP_MS);
    await settled(app);
    await graphSettled(app);
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('.og-menubar-item')`), ['File', 'Edit', 'View', 'Engine', 'Viewport', 'Graph', 'Inspector', 'Library', 'Help']);
    t.diagnostic(`nodes: ${JSON.stringify(ids)}`);
    /** What was chosen, to hold against what the menus list at the end. */
    const chosen = new Set<string>();
    const pick = async (menu: string, id: string): Promise<void> => {
      await choose(app, menu, id);
      chosen.add(`${menu} > ${id}`);
    };
    const never = new Set<string>();

    // ================= View =================
    await pick('View', 'view.commandPalette');
    await appears(app, '[data-ui="palette"][data-mode="commands"]');
    await keyPress(app, 'Escape', {}, '.og-palette-input');
    await vanishes(app, '[data-ui="palette"]');
    const side = (): Promise<number> => app.eval<number>(`shellTest.rect('${INSPECTOR}').width`);
    const width = await side();
    await app.eval(`void shellTest.drag([...document.querySelectorAll('.dv-sash')].find((sash) => sash.getBoundingClientRect().height > 500), -120)`);
    await app.waitFor(`shellTest.rect('${INSPECTOR}').width > ${width + 100}`, PAGE_BACKSTOP_MS);
    await pick('View', 'view.resetLayout');
    await app.waitFor(`shellTest.rect('${INSPECTOR}').width === ${width}`, PAGE_BACKSTOP_MS);
    await pick('View', 'view.showErrors');
    await appears(app, '[data-dialog="errors"]');
    await press(app, '[data-dialog="errors"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="errors"]');
    await app.waitFor(`document.querySelector('[data-viewport="canvas"] canvas') !== null`, PAGE_BACKSTOP_MS);
    assert.equal(await mode(app), 'orbit');
    await pick('View', 'viewport.toggleTop');
    assert.equal(await mode(app), 'top');
    await pick('View', 'viewport.toggleTop');
    assert.equal(await mode(app), 'orbit');

    // ================= Viewport =================
    const first = await orbitOf(app);
    const size = await app.eval<{ width: number; height: number }>(`viewportTest.size()`);
    await app.eval(`void (viewportTest.drag([${size.width / 2}, ${size.height / 2}], [${size.width / 2 + 120}, ${size.height / 2 + 40}], 0, {}, 10), viewportTest.wheel(${size.width / 2}, ${size.height / 2}, 480))`);
    const moved = await orbitOf(app);
    assert.ok(Math.abs(moved.yaw - first.yaw) > 5 && Math.abs(moved.distance - first.distance) > 1, `the camera was moved: ${JSON.stringify(moved)}`);
    await pick('Viewport', 'viewport.frame');
    const framed = await orbitOf(app);
    assert.ok(Math.abs(framed.distance - first.distance) < Math.abs(moved.distance - first.distance) && Math.abs(framed.yaw - moved.yaw) < 0.01, `Frame Terrain keeps the direction and takes the whole terrain in: ${JSON.stringify(framed)}`);
    await pick('Viewport', 'viewport.resetView');
    const reset = await orbitOf(app);
    assert.ok(Math.abs(reset.yaw - first.yaw) < 0.01 && Math.abs(reset.pitch - first.pitch) < 0.01, `Reset View looks from where a new session looks: ${JSON.stringify(reset)}`);
    await pick('Viewport', 'viewport.toggleTop');
    assert.equal(await mode(app), 'top');
    assert.equal(await toolbarValue(app, 'Top view style'), 'Hillshade');
    await pick('Viewport', 'viewport.topHeight');
    assert.equal(await toolbarValue(app, 'Top view style'), 'Height');
    await pick('Viewport', 'viewport.topOverlay');
    assert.equal(await toolbarValue(app, 'Top view style'), 'Overlay');
    await pick('Viewport', 'viewport.topHillshade');
    assert.equal(await toolbarValue(app, 'Top view style'), 'Hillshade');
    await pick('Viewport', 'viewport.toggleTop');
    assert.equal(await mode(app), 'orbit');
    assert.equal(await toolbarValue(app, 'Shading'), 'Material');
    await pick('Viewport', 'viewport.shadingClay');
    assert.equal(await toolbarValue(app, 'Shading'), 'Clay');
    await pick('Viewport', 'viewport.shadingMaterial');
    assert.equal(await toolbarValue(app, 'Shading'), 'Material');
    const sea = (): Promise<string | null> => attr(app, '[data-viewport="toolbar"] [data-ui="checkbox"]', 'aria-checked');
    const shownSea = await sea();
    await pick('Viewport', 'viewport.toggleSea');
    assert.notEqual(await sea(), shownSea);
    await pick('Viewport', 'viewport.toggleSea');
    assert.equal(await sea(), shownSea);
    // The sun, moved by a Shift-drag in the view, and put back.
    const sun = async (): Promise<number> => {
      await press(app, '[data-viewport="sun"]');
      await appears(app, '[aria-label="Sun direction"]');
      const value = await numberOf(app, '[aria-label="Sun direction"]');
      await keyPress(app, 'Escape', {}, '[aria-label="Sun direction"]');
      await vanishes(app, '[aria-label="Sun direction"]');
      return value;
    };
    const noon = await sun();
    await app.eval(`void viewportTest.drag([${size.width / 2}, ${size.height / 2}], [${size.width / 2 + 90}, ${size.height / 2}], 0, { shiftKey: true }, 8)`);
    assert.notEqual(await sun(), noon, 'Shift-drag moved the sun');
    await pick('Viewport', 'viewport.resetSun');
    assert.equal(await sun(), noon);
    // The vertical scale, typed, and put back.
    const scale = '[data-viewport="toolbar"] [aria-label="Vertical scale"]';
    await press(app, scale);
    await appears(app, `${scale} input`);
    await typeInto(app, `${scale} input`, '2');
    await keyPress(app, 'Enter', {}, `${scale} input`);
    assert.equal(await numberOf(app, scale), 2);
    await pick('Viewport', 'viewport.resetVerticalScale');
    assert.equal(await numberOf(app, scale), 1);
    // The overlay: a mask is selected, its palette goes to the next, and the overlay is taken away.
    assert.equal(await enabledIn(app, 'Viewport', 'viewport.removeOverlay'), false, 'nothing lies over the terrain yet');
    await selectNode(app, ids.slope);
    await settled(app);
    assert.equal((await viewOf(app)).overlay?.as, 'mask');
    const palette = async (): Promise<string | null> => {
      await press(app, '[data-viewport="overlay"]');
      await appears(app, '[aria-label="Overlay palette"]');
      const value = await text(app, '[aria-label="Overlay palette"]');
      await keyPress(app, 'Escape', {}, '[aria-label="Overlay palette"]');
      await vanishes(app, '[aria-label="Overlay palette"]');
      return value;
    };
    const tint = await palette();
    await pick('Viewport', 'viewport.nextPalette');
    assert.notEqual(await palette(), tint);
    await pick('Viewport', 'viewport.removeOverlay');
    assert.equal((await viewOf(app)).overlay, undefined);
    await settled(app);

    // ================= Graph =================
    await focusGraph(app);
    assert.deepEqual(await selection(app), []);
    for (const id of ['graph.insertNode', 'graph.duplicate', 'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', 'graph.group', 'graph.selectContents']) {
      assert.equal(await enabledIn(app, 'Graph', id), false, `${id} has nothing to act on`);
    }
    await pick('Graph', 'graph.addNode');
    await appears(app, `${PALETTE} input`);
    await keyPress(app, 'Escape', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    // A wire is selected: Insert Node… opens the palette for it.
    const wire = Object.values((await docOf(app)).edges).find((edge) => edge.from.node === ids.range && edge.to.node === ids.blur)!;
    const middle = await app.eval<{ x: number; y: number }>(`graphTest.wire(${quote(wire.id)})`);
    await graphClick(app, middle);
    await pick('Graph', 'graph.insertNode');
    await appears(app, `${PALETTE} input`);
    await typeInto(app, `${PALETTE} input`, 'terraces');
    await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === 'surface/terraces'`, PAGE_BACKSTOP_MS);
    await keyPress(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    let doc = await docOf(app);
    const terraces = Object.values(doc.nodes).find((node) => node.type === 'surface/terraces')!.id;
    assert.ok(Object.values(doc.edges).some((edge) => edge.from.node === ids.range && edge.to.node === terraces) && Object.values(doc.edges).some((edge) => edge.from.node === terraces && edge.to.node === ids.blur), 'the node went into the wire');
    await keyPress(app, 'KeyZ', { ctrl: true });
    assert.equal(Object.hasOwn((await docOf(app)).nodes, terraces), false);

    await selectNode(app, ids.blur);
    await pick('Graph', 'graph.duplicate');
    doc = await docOf(app);
    assert.equal(Object.values(doc.nodes).filter((node) => node.type === 'filter/blur').length, 2);
    await keyPress(app, 'KeyZ', { ctrl: true });
    await selectNode(app, ids.blur);
    await pick('Graph', 'graph.rename');
    const rename = `[data-node="${ids.blur}"] [data-graph="rename"]`;
    await appears(app, rename);
    await typeInto(app, rename, 'Soften');
    await keyPress(app, 'Enter', {}, rename);
    await vanishes(app, rename);
    assert.equal((await nodeOf(app, ids.blur)).title, 'Soften');
    await pick('Graph', 'graph.toggleBypass');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true);
    await pick('Graph', 'graph.toggleBypass');
    assert.equal((await nodeOf(app, ids.blur)).bypass, undefined);
    await pick('Graph', 'graph.toggleCollapse');
    assert.equal((await nodeOf(app, ids.blur)).collapsed, true);
    await pick('Graph', 'graph.toggleCollapse');
    assert.equal((await nodeOf(app, ids.blur)).collapsed, undefined);
    await selectNode(app, ids.slope);
    await pick('Graph', 'graph.group');
    doc = await docOf(app);
    assert.equal(Object.keys(doc.groups).length, 2);
    await keyPress(app, 'KeyZ', { ctrl: true });
    // The group the project brought: selected by its title bar, its contents by the command.
    await app.eval(`void (() => { const at = graphTest.group(${quote(ids.group)}); graphTest.click(at.x, at.y); })()`);
    await pick('Graph', 'graph.selectContents');
    assert.deepEqual((await selection(app)).sort(), [ids.range, ids.blur].sort());
    // Use as Terrain: with a mask over it the selected terrain is not what is shown until the command says so.
    await selectNode(app, ids.range);
    await settled(app);
    await pick('Graph', 'graph.toggleViewLock');
    assert.equal((await viewOf(app)).locked, true);
    await selectNode(app, ids.blur);
    assert.deepEqual((await viewOf(app)).height, { node: ids.range, port: 'out' }, 'the locked view stays');
    await pick('Graph', 'graph.useAsTerrain');
    assert.deepEqual((await viewOf(app)).height, { node: ids.blur, port: 'out' }, 'Use as Terrain shows the selection even in a locked view');
    await pick('Graph', 'graph.toggleViewLock');
    assert.equal((await viewOf(app)).locked, undefined);
    await settled(app);
    // Fit: after the wheel has brought the graph near, the whole graph is in the panel again.
    const pane = await boxOf(app, '[data-graph="root"]');
    const fitted = (await docOf(app)).ui.graphViewport!;
    for (let tick = 0; tick < 4; tick++) await app.eval(`void graphTest.wheel(${pane.x + 200}, ${pane.y + 200}, -120)`);
    await graphSettled(app);
    assert.ok((await docOf(app)).ui.graphViewport!.zoom > fitted.zoom);
    await appears(app, '.react-flow__minimap');
    await pick('Graph', 'graph.toggleMinimap');
    await vanishes(app, '.react-flow__minimap');
    await pick('Graph', 'graph.toggleMinimap');
    await appears(app, '.react-flow__minimap');
    await pick('Graph', 'graph.fit');
    await app.waitFor(`Math.abs((orogenTest.ctx.doc.getState().doc.ui.graphViewport?.zoom ?? 0) - ${fitted.zoom}) < 0.01`, PAGE_BACKSTOP_MS);
    await graphSettled(app);
    await vanishes(app, '.react-flow__minimap');

    // ================= Inspector =================
    await showTab(app, 'Inspector');
    await selectNode(app, ids.noise);
    await settled(app);
    await appears(app, `${INSPECTOR} [data-param="gain"]`);
    await pick('Inspector', 'inspector.rename');
    await app.waitFor(`document.activeElement === document.querySelector('${INSPECTOR} [aria-label="Node title"]')`, PAGE_BACKSTOP_MS);
    await typeInto(app, `${INSPECTOR} [aria-label="Node title"]`, 'Grain');
    await keyPress(app, 'Enter', {}, `${INSPECTOR} [aria-label="Node title"]`);
    assert.equal((await nodeOf(app, ids.noise)).title, 'Grain');
    assert.equal(await text(app, `[data-node="${ids.noise}"] [data-role="title"]`), 'Grain');
    assert.equal(await enabledIn(app, 'Inspector', 'inspector.toggleBypass'), false, 'a node without an input has nothing to pass through');
    assert.equal(await enabledIn(app, 'Inspector', 'inspector.resetParameter'), false, 'no parameter is changed yet');
    assert.equal(await enabledIn(app, 'Inspector', 'inspector.reloadFiles'), false, 'the node reads no file');
    const gain = `${INSPECTOR} [data-param="gain"] [data-ui="number-field"]`;
    const octaves = `${INSPECTOR} [data-param="octaves"] [data-ui="number-field"]`;
    const defaults = (await nodeOf(app, ids.noise)).params;
    await app.eval(`void shellTest.drag(${quote(octaves)}, -40, {}, 6, true)`);
    await app.eval(`void shellTest.drag(${quote(gain)}, 40, {}, 6, true)`);
    const dragged = await nodeOf(app, ids.noise);
    assert.ok(dragged.params.gain !== defaults.gain && dragged.params.octaves !== defaults.octaves, JSON.stringify(dragged.params));
    await pick('Inspector', 'inspector.resetParameter');
    assert.equal((await nodeOf(app, ids.noise)).params.gain, defaults.gain, 'the parameter dragged last is the one that is reset');
    assert.equal((await nodeOf(app, ids.noise)).params.octaves, dragged.params.octaves);
    await pick('Inspector', 'inspector.resetAll');
    assert.equal((await nodeOf(app, ids.noise)).params.octaves, defaults.octaves);
    const seed = (await nodeOf(app, ids.noise)).params.seed;
    await pick('Inspector', 'inspector.randomizeSeed');
    assert.notEqual((await nodeOf(app, ids.noise)).params.seed, seed);
    const sections = (): Promise<boolean[]> => app.eval<boolean[]>(`[...document.querySelectorAll('${INSPECTOR} [data-section]')].map((section) => section.hasAttribute('data-open'))`);
    assert.ok((await sections()).length > 0, 'the node has sections');
    await pick('Inspector', 'inspector.collapseAll');
    assert.ok((await sections()).every((open) => !open));
    await pick('Inspector', 'inspector.expandAll');
    assert.ok((await sections()).every((open) => open));
    await selectNode(app, ids.blur);
    await appears(app, `${INSPECTOR} [data-param="radius"]`);
    await pick('Inspector', 'inspector.toggleBypass');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true);
    assert.equal(await attr(app, `[data-node="${ids.blur}"]`, 'data-bypassed'), '', 'and the graph shows it');
    await pick('Inspector', 'inspector.toggleBypass');
    assert.equal((await nodeOf(app, ids.blur)).bypass, undefined);
    // Reload Files: the engine is told its project again, and the node that reads a file is asked for anew.
    await selectNode(app, ids.imported);
    await settled(app);
    const request = await app.eval<number>(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}].requestId`);
    await pick('Inspector', 'inspector.reloadFiles');
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}].requestId > ${request}`, EVALUATION_BACKSTOP_MS);
    await settled(app);

    // ================= Library =================
    // The library is behind the build panel: its commands bring it to the front.
    await showTab(app, 'Build');
    await app.waitFor(`document.querySelector('[data-panel="library"]') === null`, PAGE_BACKSTOP_MS);
    await pick('Library', 'library.showNodes');
    await appears(app, '[data-panel="library"] [data-library="nodes"]');
    assert.equal(await focusedPanel(app), 'library');
    await pick('Library', 'library.collapseAll');
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-library="list"] [data-node]').length`), 0, 'every category is folded');
    await pick('Library', 'library.expandAll');
    assert.ok(await app.eval<number>(`document.querySelectorAll('[data-library="list"] [data-node]').length`) > 80);
    await pick('Library', 'library.search');
    await app.waitFor(`document.activeElement === document.querySelector('[data-library="search"]')`, PAGE_BACKSTOP_MS);
    await typeInto(app, '[data-library="search"]', 'curve');
    await app.waitFor(`document.querySelector('[data-library="list"] [role="option"][aria-selected="true"]')?.getAttribute('data-node') === 'adjust/curve'`, PAGE_BACKSTOP_MS);
    const count = Object.keys((await docOf(app)).nodes).length;
    await pick('Library', 'library.addNode');
    await app.waitFor(`Object.keys(orogenTest.ctx.doc.getState().doc.nodes).length === ${count + 1}`, PAGE_BACKSTOP_MS);
    const curve = Object.values((await docOf(app)).nodes).find((node) => node.type === 'adjust/curve')!.id;
    assert.deepEqual(await selection(app), [curve], 'the graph added the node and selected it');
    // The node that was added is the newest of the recently used: the list has it, and the command empties the list.
    await showTab(app, 'Library');
    await keyPress(app, 'Escape', {}, '[data-library="search"]');
    await app.waitFor(`document.querySelector('[data-library="list"] [data-section="recent"]') !== null`, PAGE_BACKSTOP_MS);
    await pick('Library', 'library.clearRecent');
    await app.waitFor(`document.querySelector('[data-library="list"] [data-section="recent"]') === null`, PAGE_BACKSTOP_MS);
    await pick('Library', 'library.showExamples');
    await appears(app, '[data-library="examples"][data-place="panel"]');
    assert.equal(await enabledIn(app, 'Library', 'library.openExample'), false, 'no example is selected');
    await press(app, '[data-library="examples"] [data-example="first-terrain"]');
    await capture(app, '01-library-examples');
    // The project has changes: the example opens after the question, answered "Don't Save".
    await pick('Library', 'library.openExample');
    // The shell's own question, as File > Open asks it: the example is opened by the project service.
    await appears(app, '[data-dialog="unsaved"]');
    await press(app, '[data-dialog="unsaved"] [data-action="discard"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === null && Object.keys(orogenTest.ctx.doc.getState().doc.nodes).length === 3`, PAGE_BACKSTOP_MS);
    await settled(app, 120_000);

    // ================= Engine =================
    await pick('Engine', 'engine.togglePause');
    assert.equal(await paused(app), true);
    assert.equal(await text(app, '[data-status="device"]'), 'Previews paused');
    await pick('Engine', 'engine.togglePause');
    assert.equal(await paused(app), false);
    assert.equal(await enabledIn(app, 'Engine', 'engine.retryDevice'), false, 'the device is there');
    never.add('Engine > engine.retryDevice');
    assert.equal(await enabledIn(app, 'Engine', 'build.cancel'), false, 'no build runs');
    // Build: the first of a project asks for its folder.
    const out = path.join(FOLDER, 'menu-build');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)})`);
    await showTab(app, 'Build');
    await chooseSmallest(app);
    await pick('Engine', 'build.start');
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.result?.outDir === ${quote(out)} && !orogenTest.ctx.engineState.getState().build.running`, 240_000);
    assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().build.result.status`), 'ok');
    const written = await app.eval<string[]>(`orogenTest.ctx.engineState.getState().build.result.files.map((file) => file.path)`);
    const heightmap = written.find((name) => /Height\.png$/.test(name));
    assert.ok(heightmap !== undefined && fs.existsSync(path.join(out, heightmap)), `the build wrote its heightmap: ${written.join(', ')}`);
    await settled(app, 120_000);
    // Cancel Build: of a build at the largest size, chosen while it runs.
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="8129"]');
    await press(app, '[data-ui="select-list"] [data-value="8129"]');
    await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
    await pick('Engine', 'build.start');
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.running`, PAGE_BACKSTOP_MS);
    await pick('Engine', 'build.cancel');
    await app.waitFor(`!orogenTest.ctx.engineState.getState().build.running && orogenTest.ctx.engineState.getState().build.lastStatus === 'aborted'`, 240_000);
    assert.ok(fs.existsSync(path.join(out, heightmap)) && fs.statSync(path.join(out, heightmap.replace(/\.png$/, '.r16'))).size === 2 * 1009 * 1009, 'the cancelled build left the earlier one in place');
    await app.eval(`void [...document.querySelectorAll('[data-ui="notice"] [aria-label="Dismiss"]')].forEach((button) => shellTest.press(button))`);
    // Restart Engine: another worker, another canvas, and the project is shown again.
    await app.eval(`void (window.gateCanvas = document.querySelector('[data-viewport="canvas"] canvas'))`);
    const saidOfTheBuild = await text(app, '[data-build="status-line"]');
    assert.equal(saidOfTheBuild, 'Build cancelled');
    await pick('Engine', 'engine.restart');
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready' && document.querySelector('[data-viewport="canvas"] canvas') !== window.gateCanvas`, EVALUATION_BACKSTOP_MS);
    await settled(app, 240_000);
    // What the last build did is still said: the engine went, the folder and its build did not.
    assert.equal(await text(app, '[data-build="status-line"]'), saidOfTheBuild);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.engineState.getState().build.lastStatus`), 'aborted');
    await capture(app, '02-after-the-menus');

    // ---- every item of the six menus was chosen, but the one that needs a device that failed ----
    for (const menu of ['View', 'Engine', 'Viewport', 'Graph', 'Inspector', 'Library']) {
      const items = await openMenu(app, menu);
      await closeMenu(app);
      for (const item of items) {
        const name = `${menu} > ${item.id}`;
        assert.ok(chosen.has(name) || never.has(name), `${name} was chosen`);
      }
    }
    assert.deepEqual([...never], ['Engine > engine.retryDevice']);
    assert.deepEqual(await failures(app), [], 'no command failed');
    t.diagnostic(`${chosen.size} menu items chosen`);
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});

/** The smallest resolution the build panel offers. */
async function chooseSmallest(app: AppDriver): Promise<void> {
  await press(app, '#build-resolution');
  await appears(app, '[data-ui="select-list"] [data-value="1009"]');
  await press(app, '[data-ui="select-list"] [data-value="1009"]');
  await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
}

test('gate: every default key of runtime.md 8.8 runs its command in its scope, and only there', async (t) => {
  const file = project('keys');
  const app = await start({ open: file });
  try {
    await app.waitFor(`orogenTest.ctx.doc.getState().path !== null`, PAGE_BACKSTOP_MS);
    await settled(app);
    await graphSettled(app);
    const pathOf = (): Promise<string | null> => app.eval<string | null>(`orogenTest.ctx.doc.getState().path`);
    const count = async (): Promise<number> => Object.keys((await docOf(app)).nodes).length;

    // ================= the graph's scope =================
    await focusGraph(app);
    assert.equal(await focusedPanel(app), 'graph');
    // Tab: the palette.
    await keyPress(app, 'Tab');
    await appears(app, `${PALETTE} input`);
    await keyPress(app, 'Escape', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    // B: bypass.
    await selectNode(app, ids.blur);
    await keyPress(app, 'KeyB');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true);
    await keyPress(app, 'KeyB');
    assert.equal((await nodeOf(app, ids.blur)).bypass, undefined);
    // Mod+D: duplicate. Delete and Backspace: delete.
    const nodesBefore = await count();
    await keyPress(app, 'KeyD', { ctrl: true });
    assert.equal(await count(), nodesBefore + 1);
    await keyPress(app, 'Delete');
    assert.equal(await count(), nodesBefore);
    await selectNode(app, ids.noise);
    await keyPress(app, 'Backspace');
    assert.equal(await count(), nodesBefore - 1);
    // Mod+Z, Mod+Shift+Z and Mod+Y, which are global, with the focus in the graph.
    await keyPress(app, 'KeyZ', { ctrl: true });
    assert.equal(await count(), nodesBefore);
    await keyPress(app, 'KeyZ', { ctrl: true, shift: true });
    assert.equal(await count(), nodesBefore - 1);
    await keyPress(app, 'KeyZ', { ctrl: true });
    await keyPress(app, 'KeyY', { ctrl: true });
    assert.equal(await count(), nodesBefore - 1, 'Mod+Y redoes as Mod+Shift+Z does');
    await keyPress(app, 'KeyZ', { ctrl: true });
    assert.equal(await count(), nodesBefore);
    // F: the view is locked to the selection. G: the selection is the terrain shown.
    await selectNode(app, ids.range);
    await keyPress(app, 'KeyF');
    assert.equal((await viewOf(app)).locked, true);
    await selectNode(app, ids.blur);
    assert.deepEqual((await viewOf(app)).height, { node: ids.range, port: 'out' });
    await keyPress(app, 'KeyG');
    assert.deepEqual((await viewOf(app)).height, { node: ids.blur, port: 'out' });
    await keyPress(app, 'KeyF');
    assert.equal((await viewOf(app)).locked, undefined);
    // Mod+G: group.
    const groups = Object.keys((await docOf(app)).groups).length;
    await keyPress(app, 'KeyG', { ctrl: true });
    assert.equal(Object.keys((await docOf(app)).groups).length, groups + 1);
    assert.deepEqual((await viewOf(app)).height, { node: ids.blur, port: 'out' }, 'Mod+G is not G');
    await keyPress(app, 'KeyZ', { ctrl: true });
    // F2: rename.
    await selectNode(app, ids.blur);
    await keyPress(app, 'F2');
    const rename = `[data-node="${ids.blur}"] [data-graph="rename"]`;
    await appears(app, rename);
    await keyPress(app, 'Escape', {}, rename);
    await vanishes(app, rename);
    // Mod+0 and Home: fit.
    const pane = await boxOf(app, '[data-graph="root"]');
    const fitted = (await docOf(app)).ui.graphViewport!;
    for (const [code, mods] of [['Digit0', { ctrl: true }], ['Home', {}]] as const) {
      for (let tick = 0; tick < 4; tick++) await app.eval(`void graphTest.wheel(${pane.x + 200}, ${pane.y + 200}, -120)`);
      await graphSettled(app);
      assert.ok((await docOf(app)).ui.graphViewport!.zoom > fitted.zoom + 0.05);
      await focusGraph(app);
      await keyPress(app, code, mods);
      // The fit is the library's and comes a frame later; the document has it a quarter of a second after that.
      await app.waitFor(`Math.abs((orogenTest.ctx.doc.getState().doc.ui.graphViewport?.zoom ?? 0) - ${fitted.zoom}) < 0.01`, PAGE_BACKSTOP_MS).catch(async (thrown: unknown) => {
        throw new Error(`${code} did not fit the graph: ${JSON.stringify((await docOf(app)).ui.graphViewport)} against ${JSON.stringify(fitted)}`, { cause: thrown });
      });
      await graphSettled(app);
    }
    await settled(app);

    // ================= the viewport's scope =================
    await focusViewport(app);
    assert.equal(await focusedPanel(app), 'viewport');
    const first = await orbitOf(app);
    const size = await app.eval<{ width: number; height: number }>(`viewportTest.size()`);
    await app.eval(`void (viewportTest.drag([${size.width / 2}, ${size.height / 2}], [${size.width / 2 + 120}, ${size.height / 2 + 40}], 0, {}, 10), viewportTest.wheel(${size.width / 2}, ${size.height / 2}, 480))`);
    const moved = await orbitOf(app);
    // F: frame the terrain (and not the graph's lock). Home: the first direction (and not the graph's fit).
    const graphView = (await docOf(app)).ui.graphViewport;
    await keyPress(app, 'KeyF');
    const framed = await orbitOf(app);
    assert.ok(Math.abs(framed.distance - first.distance) < Math.abs(moved.distance - first.distance) && Math.abs(framed.yaw - moved.yaw) < 0.01, `F frames: ${JSON.stringify(framed)}`);
    assert.equal((await viewOf(app)).locked, undefined, 'F in the viewport is not the graph\'s lock');
    await keyPress(app, 'Home');
    const home = await orbitOf(app);
    assert.ok(Math.abs(home.yaw - first.yaw) < 0.01 && Math.abs(home.pitch - first.pitch) < 0.01, `Home resets the view: ${JSON.stringify(home)}`);
    assert.deepEqual((await docOf(app)).ui.graphViewport, graphView, 'Home in the viewport leaves the graph alone');
    // The canvas's own keys, which are no commands: the arrows turn the camera, plus and minus dolly.
    // Home frames twice, the second time around the heights the engine names a moment later (while no hand has
    // moved the camera): a key is held against the camera of the same turn of the page, not against `home`.
    const [atHome, turned] = await canvasKey(app, 'ArrowLeft');
    assert.ok(Math.abs(atHome.yaw - home.yaw) < 0.01 && Math.abs(atHome.pitch - home.pitch) < 0.01, 'the second framing keeps the direction');
    assert.ok(Math.abs(turned.yaw - atHome.yaw) > 1 && Math.abs(turned.distance - atHome.distance) < 1e-6, `an arrow turns the camera: ${JSON.stringify([atHome, turned])}`);
    const [before, nearer] = await canvasKey(app, 'Equal');
    assert.ok(Math.abs(before.distance - turned.distance) < 1e-6, `a camera a hand has turned is framed no more: ${JSON.stringify([turned, before])}`);
    assert.ok(nearer.distance < before.distance, 'plus comes nearer');
    const [, back] = await canvasKey(app, 'Minus');
    assert.ok(Math.abs(back.distance - turned.distance) < 1e-6 * turned.distance + 1e-6, 'and minus goes back');
    // The graph's keys are not the viewport's: B, G, Delete, Tab, F2 and Mod+D change nothing here.
    const held = serializeDoc(await docOf(app));
    for (const [code, mods] of [['KeyB', {}], ['KeyG', {}], ['Delete', {}], ['Backspace', {}], ['F2', {}], ['KeyD', { ctrl: true }], ['KeyG', { ctrl: true }], ['Tab', {}]] as const) await keyPress(app, code, mods);
    assert.ok(serializeDoc(await docOf(app)) === held, 'the document is as it was');
    assert.equal(await app.eval<boolean>(`document.querySelector(${quote(PALETTE)}) === null && document.querySelector('[data-graph="rename"]') === null`), true);

    // ================= the inspector's scope: its own F2 and B, and none of the graph's others =================
    await showTab(app, 'Inspector');
    await focusGraph(app);
    await selectNode(app, ids.blur);
    await appears(app, `${INSPECTOR} [data-param="radius"]`);
    await press(app, `${INSPECTOR} [data-inspector-about]`);
    assert.equal(await focusedPanel(app), 'inspector');
    await keyPress(app, 'KeyB');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true, 'B in the inspector bypasses the node it shows');
    await keyPress(app, 'KeyB');
    await keyPress(app, 'F2');
    await app.waitFor(`document.activeElement === document.querySelector('${INSPECTOR} [aria-label="Node title"]')`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-graph="rename"]') === null`), true, 'F2 in the inspector is the inspector\'s field, not the graph\'s');
    await keyPress(app, 'Escape', {}, `${INSPECTOR} [aria-label="Node title"]`);
    await press(app, `${INSPECTOR} [data-inspector-about]`);
    const kept = serializeDoc(await docOf(app));
    for (const [code, mods] of [['Delete', {}], ['KeyG', {}], ['KeyF', {}], ['Tab', {}], ['Home', {}], ['KeyD', { ctrl: true }]] as const) await keyPress(app, code, mods);
    assert.ok(serializeDoc(await docOf(app)) === kept);
    assert.equal(await app.eval<boolean>(`document.querySelector(${quote(PALETTE)}) === null`), true);

    // ================= global keys, from wherever the focus is =================
    // F6: the view from above, and back.
    await keyPress(app, 'F6');
    assert.equal(await mode(app), 'top');
    await keyPress(app, 'F6');
    assert.equal(await mode(app), 'orbit');
    // Backquote: pause and resume.
    await keyPress(app, 'Backquote');
    assert.equal(await paused(app), true);
    await keyPress(app, 'Backquote');
    assert.equal(await paused(app), false);
    // Mod+Shift+P and F1: the palette of commands.
    for (const [code, mods] of [['KeyP', { ctrl: true, shift: true }], ['F1', {}]] as const) {
      await keyPress(app, code, mods);
      await appears(app, '[data-ui="palette"][data-mode="commands"]');
      await keyPress(app, 'Escape', {}, '.og-palette-input');
      await vanishes(app, '[data-ui="palette"]');
    }
    // Mod+Comma: the preferences.
    await keyPress(app, 'Comma', { ctrl: true });
    await appears(app, '[data-dialog="preferences"]');
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="preferences"]');
    // Mod+S: saves to the project's file. Mod+Shift+S: asks for another.
    await focusGraph(app);
    await selectNode(app, ids.blur);
    await keyPress(app, 'KeyB');
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), true);
    await keyPress(app, 'KeyS', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as GraphDoc).nodes[ids.blur]!.bypass, true);
    const copy = path.join(FOLDER, 'keys-copy.orogen');
    await app.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(copy)})`);
    await keyPress(app, 'KeyS', { ctrl: true, shift: true });
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(copy)}`, PAGE_BACKSTOP_MS);
    assert.ok(fs.existsSync(copy));
    // Mod+N: a new project. Mod+O: the file again.
    await keyPress(app, 'KeyN', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.doc.getState().path === null`, PAGE_BACKSTOP_MS);
    assert.equal(await count(), 1);
    await app.eval(`void orogenTest.shell.answers.openProjectDialog.push(${quote(file)})`);
    await keyPress(app, 'KeyO', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    assert.equal(await pathOf(), file);
    await settled(app);
    // Mod+B: builds. The project's first build asks for the folder.
    const out = path.join(FOLDER, 'key-build');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)})`);
    await keyPress(app, 'KeyB', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.result?.outDir === ${quote(out)} && !orogenTest.ctx.engineState.getState().build.running`, 240_000);
    assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().build.result.status`), 'ok');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true, 'Mod+B is not B: the node is as it was saved');
    await settled(app, 120_000);

    // ---- while text is typed, a plain key is a letter: B in the title field bypasses nothing ----
    await showTab(app, 'Inspector');
    await focusGraph(app);
    await selectNode(app, ids.blur);
    await press(app, `${INSPECTOR} [aria-label="Node title"]`);
    await app.eval(`void shellTest.focus('${INSPECTOR} [aria-label="Node title"]')`);
    const went = await keyPress(app, 'KeyB', {}, `${INSPECTOR} [aria-label="Node title"]`);
    assert.equal(went, true, 'the key is left to the field');
    assert.equal((await nodeOf(app, ids.blur)).bypass, true);
    await keyPress(app, 'Escape', {}, `${INSPECTOR} [aria-label="Node title"]`);

    assert.deepEqual(await failures(app), [], 'no command failed');
    await capture(app, '03-after-the-keys');
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});
