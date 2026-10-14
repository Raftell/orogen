// What the five panels must agree on, seen in one window (runtime.md 8.7 rule 2: panels affect each other only
// through the stores and through commands): one node has one title, one colour and one status wherever it is
// shown; the selection of the graph is what the inspector and the viewport show; an error is said in the graph,
// in the inspector and in the status bar, and leaves all three together.
//
// Input is synthesised; no store is written. Captures: test-output/ui/gate-consistency/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { AppDriver } from '../../helpers/index.ts';
import {
  addedNode, appears, attr, boxOf, capture as captureIn, docOf, EVALUATION_BACKSTOP_MS, focusedPanel, graphClick, graphDrag, graphHover, graphSettled, graphWheel,
  history, keyPress, nodeBox, OUTPUT, PAGE_BACKSTOP_MS, portAt, press, quote, ROOT, selection, selectNode, settled, showTab, start, text, titleAt, typeInto, vanishes,
} from './gate-rig.ts';

const SHOTS = 'gate-consistency';
fs.rmSync(path.join(OUTPUT, 'ui', SHOTS), { recursive: true, force: true });
const capture = (app: AppDriver, name: string): Promise<string> => captureIn(app, SHOTS, name);

const PALETTE = '[data-graph="palette"]';
const INSPECTOR = '[data-panel="inspector"]';
const titleField = `${INSPECTOR} [aria-label="Node title"]`;

/** The value of a theme token, as the browser resolves it into a colour. */
const token = (app: AppDriver, name: string): Promise<string> => app.eval<string>(`(() => {
  const probe = document.createElement('div');
  probe.style.background = 'var(${name})';
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
})()`);

/** What the graph says of a node: its title, the colour of its header, its status. */
const inGraph = (app: AppDriver, id: string): Promise<{ title: string; color: string; category: string; status: string; line: string }> => app.eval(`(() => {
  const node = document.querySelector('[data-graph="root"] [data-node="${id}"]');
  const title = node.querySelector('[data-role="title"]');
  return {
    title: title.textContent, color: getComputedStyle(title.parentElement).backgroundColor, category: node.getAttribute('data-category'),
    status: node.getAttribute('data-status'), line: node.querySelector('[data-role="status"]').textContent,
  };
})()`);

/** What the inspector says of the node it shows. */
const inInspector = (app: AppDriver): Promise<{ title: string; type: string; id: string; color: string; status: string; state: string }> => app.eval(`(() => {
  const header = document.querySelector('${INSPECTOR} [data-inspector-header]');
  const lines = header.querySelectorAll('span');
  return {
    title: header.querySelector('[aria-label="Node title"]').value, id: header.getAttribute('data-inspector-header'),
    type: [...lines].map((line) => line.textContent).find((line) => line !== '' && line !== 'Bypass' && line !== 'mixed') ?? '',
    color: getComputedStyle(header.firstElementChild).backgroundColor,
    status: document.querySelector('${INSPECTOR} [data-status-text]')?.textContent ?? '',
    state: document.querySelector('${INSPECTOR} [data-node-status]')?.getAttribute('data-node-status') ?? '',
  };
})()`);

/** What the library says of a node type: the title of its row and the colour of the row's edge. */
const inLibrary = (app: AppDriver, type: string): Promise<{ title: string; color: string } | null> => app.eval(`(() => {
  const row = document.querySelector('[data-panel="library"] [data-library="list"] [data-node="${type}"]');
  if (!row) return null;
  return { title: row.querySelector('[class*="nodeTitle"]').textContent, color: getComputedStyle(row).borderLeftColor };
})()`);

const errorsShown = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`(() => {
  const item = document.querySelector('[data-status="errors"]');
  return item && item.classList.contains('og-status-error') ? item.textContent : null;
})()`);

/** Types into the graph's palette and waits until the list has the node type in front. */
async function searchPalette(app: AppDriver, query: string, first: string): Promise<void> {
  await appears(app, `${PALETTE} input`);
  await typeInto(app, `${PALETTE} input`, query);
  await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === ${quote(first)}`, PAGE_BACKSTOP_MS);
}

/** Brings the nodes of the example near enough to read: the wheel over one of them. */
async function zoomTo(app: AppDriver, id: string): Promise<void> {
  const block = await nodeBox(app, id);
  const over = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
  await graphHover(app, over);
  for (let tick = 0; tick < 12 && (await app.eval<string>(`graphTest.lod()`)) !== 'near'; tick++) await graphWheel(app, over, -120);
  await graphSettled(app);
}

async function openAlpine(app: AppDriver): Promise<void> {
  await showTab(app, 'Library');
  await press(app, '[data-panel="library"] [data-tab="examples"]');
  await appears(app, '[data-library="examples"] [data-example="alpine-range"]');
  await press(app, '[data-library="examples"] [data-example="alpine-range"] [data-action="open"]');
  await app.waitFor(`Object.hasOwn(orogenTest.ctx.doc.getState().doc.nodes, 'hydraulic')`, PAGE_BACKSTOP_MS);
  await settled(app);
  await graphSettled(app);
}

test('gate: a node has one title, one colour and one status in the graph, the library and the inspector', async (t) => {
  const app = await start();
  try {
    await openAlpine(app);
    const doc = await docOf(app);

    // ---- colour: every node of the graph has the colour of its category, which is the theme's token ----
    const categories = new Set<string>();
    for (const id of Object.keys(doc.nodes)) {
      const shown = await inGraph(app, id);
      categories.add(shown.category);
      assert.equal(shown.color, await token(app, `--og-category-${shown.category}`), `${id} has the colour of ${shown.category}`);
    }
    assert.deepEqual([...categories].sort(), ['adjust', 'color', 'generate', 'io', 'select', 'simulate']);

    // ---- the library lists every type of the project under the same title and the same colour ----
    await press(app, '[data-panel="library"] [data-tab="nodes"]');
    await appears(app, '[data-library="list"] [data-node="simulate/hydraulic-erosion"]');
    const typeTitles = new Map<string, string>();
    for (const [id, node] of Object.entries(doc.nodes)) {
      const row = await inLibrary(app, node.type);
      assert.ok(row !== null, `the library lists ${node.type}`);
      const shown = await inGraph(app, id);
      assert.equal(row.color, shown.color, `${node.type}: the library's row has the colour of the graph's node`);
      typeTitles.set(node.type, row.title);
    }
    await capture(app, '01-graph-and-library');

    // ---- the inspector: one node of each category, selected in the graph ----
    await showTab(app, 'Inspector');
    await zoomTo(app, 'hydraulic');
    for (const id of ['hydraulic', 'thermal', 'base']) {
      await selectNode(app, id);
      await app.waitFor(`document.querySelector(${quote(titleField)})?.value === ${quote(doc.nodes[id]!.title)}`, PAGE_BACKSTOP_MS);
      await settled(app);
      const [graph, inspector] = [await inGraph(app, id), await inInspector(app)];
      assert.equal(inspector.title, graph.title, `${id}: one title`);
      assert.equal(inspector.title, doc.nodes[id]!.title);
      assert.equal(inspector.id, doc.nodes[id]!.type);
      assert.equal(inspector.type, typeTitles.get(doc.nodes[id]!.type), `${id}: the type is called what the library calls it`);
      assert.equal(inspector.color, graph.color, `${id}: one colour`);
      // One status: what the graph's node says is what the inspector's head says.
      await app.waitFor(`['done', 'cached'].includes(document.querySelector('[data-graph="root"] [data-node="${id}"]').getAttribute('data-status'))`, EVALUATION_BACKSTOP_MS);
      await app.waitFor(`document.querySelector('${INSPECTOR} [data-node-status]')?.getAttribute('data-node-status') === 'done'`, PAGE_BACKSTOP_MS);
      assert.match((await inInspector(app)).status, /^Computed/, `${id}: computed in both`);
      assert.equal(await text(app, '[data-viewport="subject"]'), graph.title, `${id}: the viewport names what it shows by the same title`);
    }
    await capture(app, '02-selected-in-three-panels');

    // ---- a title given in the inspector is the graph's and the viewport's at once ----
    await selectNode(app, 'thermal');
    await press(app, titleField);
    await typeInto(app, titleField, 'Rockfall');
    await keyPress(app, 'Enter', {}, titleField);
    await app.waitFor(`document.querySelector('[data-graph="root"] [data-node="thermal"] [data-role="title"]').textContent === 'Rockfall'`, PAGE_BACKSTOP_MS);
    assert.equal((await docOf(app)).nodes.thermal!.title, 'Rockfall');
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Rockfall');
    // And one given in the graph (F2, the name, Enter) is the inspector's.
    await graphClick(app, await titleAt(app, 'thermal'));
    assert.equal(await focusedPanel(app), 'graph');
    await keyPress(app, 'F2');
    const field = '[data-node="thermal"] [data-graph="rename"]';
    await appears(app, field);
    await typeInto(app, field, 'Talus');
    await keyPress(app, 'Enter', {}, field);
    await vanishes(app, field);
    await app.waitFor(`document.querySelector(${quote(titleField)})?.value === 'Talus'`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Talus');
    // The build panel names an export by the title of what feeds it.
    await graphClick(app, await titleAt(app, 'snow'));
    await keyPress(app, 'F2');
    await appears(app, '[data-node="snow"] [data-graph="rename"]');
    await typeInto(app, '[data-node="snow"] [data-graph="rename"]', 'Glacier');
    await keyPress(app, 'Enter', {}, '[data-node="snow"] [data-graph="rename"]');
    await showTab(app, 'Build');
    // The plan of the project as it is: each target with what feeds it.
    await appears(app, '[data-build="plan-targets"] [data-build="export-source"]');
    const sources = await app.eval<string[]>(`[...document.querySelectorAll('[data-build="export-source"]')].map((e) => e.textContent)`);
    assert.ok(sources.includes('from Glacier') && !sources.includes('from Snow Cover'), `the build panel follows the title: ${sources.join(', ')}`);
    await capture(app, '03-renamed-everywhere');
    // Undo takes the names back in every panel.
    for (let step = 0; step < 3; step++) await keyPress(app, 'KeyZ', { ctrl: true });
    assert.deepEqual(await history(app), []);
    assert.equal((await inGraph(app, 'thermal')).title, 'Scree Slopes');
    assert.equal((await inGraph(app, 'snow')).title, 'Snow Cover');
    await app.waitFor(`[...document.querySelectorAll('[data-build="export-source"]')].some((e) => e.textContent === 'from Snow Cover')`, PAGE_BACKSTOP_MS);
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});

test('gate: the selection of the graph is what the inspector and the viewport show', async (t) => {
  const app = await start();
  try {
    await openAlpine(app);
    await showTab(app, 'Inspector');
    await zoomTo(app, 'thermal');
    const view = async (): Promise<unknown> => (await docOf(app)).ui.view;

    // A terrain: the inspector shows its parameters, the viewport shows it, and the graph marks it as shown.
    await selectNode(app, 'thermal');
    await settled(app);
    assert.equal((await inInspector(app)).title, 'Scree Slopes');
    // 7.4: a terrain that is selected is shown as it is; the colour map the example opened with lay over another terrain.
    assert.deepEqual(await view(), { height: { node: 'thermal', port: 'out' } });
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Scree Slopes');
    assert.equal(await attr(app, '[data-node="thermal"]', 'data-shown'), 'terrain');
    assert.equal(await attr(app, '[data-node="snow"]', 'data-shown'), null);
    assert.deepEqual(await app.eval<unknown>(`(() => { const view = orogenTest.ctx.engineState.getState().view; return [view.draft, view.revision >= orogenTest.ctx.doc.getState().engineRevision]; })()`), [false, true], 'the engine shows the document as it is now');

    // A second node with Shift: two are selected, the inspector says so, and the view stays.
    await app.eval(`void graphTest.keyDown('ShiftLeft', 'Shift', { shiftKey: true })`);
    await graphClick(app, await titleAt(app, 'hydraulic'), { shiftKey: true });
    await app.eval(`void graphTest.keyUp('ShiftLeft', 'Shift')`);
    assert.deepEqual((await selection(app)).sort(), ['hydraulic', 'thermal']);
    await appears(app, `${INSPECTOR} [data-inspector-header="summary"]`);
    assert.equal(await text(app, `${INSPECTOR} [data-field="count"]`), '2 nodes selected');
    assert.deepEqual((await view() as { height: unknown }).height, { node: 'thermal', port: 'out' });
    await capture(app, '04-two-selected');
    // The two are dragged by one of them and stay selected; a press on one of them that is let go where it began
    // selects that one alone, and the inspector shows it.
    const grip = await titleAt(app, 'thermal');
    await graphDrag(app, grip, { x: grip.x + 24, y: grip.y + 36 });
    assert.deepEqual((await selection(app)).sort(), ['hydraulic', 'thermal'], 'a drag of both leaves both selected');
    assert.deepEqual(await history(app), ['Move']);
    await selectNode(app, 'thermal');
    assert.equal((await inInspector(app)).title, 'Scree Slopes');
    await keyPress(app, 'KeyZ', { ctrl: true });
    assert.deepEqual(await history(app), []);

    // A press on the empty canvas: nothing is selected, the inspector shows the project, the view stays.
    const pane = await boxOf(app, '[data-graph="root"]');
    await graphClick(app, { x: pane.x + pane.width * 0.5, y: pane.y + pane.height - 24 });
    assert.deepEqual(await selection(app), []);
    await appears(app, `${INSPECTOR} [data-inspector-header="settings"]`);
    assert.deepEqual((await view() as { height: unknown }).height, { node: 'thermal', port: 'out' });
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Scree Slopes');

    // The view locked to a node (F in the graph): another selection is the inspector's, not the viewport's.
    await selectNode(app, 'thermal');
    await keyPress(app, 'KeyF');
    assert.equal(((await view()) as { locked?: boolean }).locked, true);
    assert.equal(await attr(app, '[data-viewport="subject"]', 'data-locked'), '', 'the viewport says that its view is pinned');
    await selectNode(app, 'hydraulic');
    assert.equal((await inInspector(app)).title, 'Gullies and Fans');
    assert.deepEqual((await view() as { height: unknown }).height, { node: 'thermal', port: 'out' }, 'a locked view does not follow');
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Scree Slopes');
    await capture(app, '05-view-locked');
    await keyPress(app, 'KeyF');
    assert.equal(((await view()) as { locked?: boolean }).locked, undefined);

    // A mask: drawn over the terrain that is shown, named by the viewport's Overlay, marked in the graph.
    await selectNode(app, 'hydraulic');
    await settled(app);
    const away = await nodeBox(app, 'rock');
    const grab = { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.9 };
    await graphDrag(app, grab, { x: grab.x + (pane.x + pane.width * 0.5 - (away.x + away.width / 2)), y: grab.y + (pane.y + pane.height * 0.45 - (away.y + away.height / 2)) }, { button: 1 });
    await graphSettled(app);
    await selectNode(app, 'rock');
    await settled(app);
    assert.deepEqual(await view(), { height: { node: 'hydraulic', port: 'out' }, overlay: { ref: { node: 'rock', port: 'out' }, as: 'mask', opacity: 1 } });
    assert.equal(await attr(app, '[data-node="rock"]', 'data-shown'), 'overlay');
    assert.equal((await inInspector(app)).title, 'Steep Rock');
    await press(app, '[data-viewport="overlay"]');
    await appears(app, '[data-viewport="overlay-source"]');
    assert.equal(await text(app, '[data-viewport="overlay-source"]'), 'Steep Rock');
    await capture(app, '06-mask-over-terrain');
    await keyPress(app, 'Escape', {}, '[data-viewport="overlay-source"]');

    // A parameter of the mask changed in the inspector is the picture's: the overlay is computed again.
    const key = (): Promise<string | undefined> => app.eval<string | undefined>(`orogenTest.ctx.engineState.getState().keys.rock`);
    const before = await key();
    const slope = `${INSPECTOR} [data-param="slopeMin"] [data-ui="number-field"]`;
    await app.eval(`void shellTest.drag(${quote(slope)}, -40, {}, 8, true)`);
    await settled(app);
    assert.notEqual(await key(), before, 'the mask has another content');
    assert.deepEqual(await history(app), ['Steep Rock: Lower slope']);
    // Undo with the focus still in the field that was dragged.
    await keyPress(app, 'KeyZ', { ctrl: true });
    assert.deepEqual(await history(app), []);
    await settled(app);
    assert.equal(await key(), before);
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});

test('gate: a failing node is said in the graph, in the inspector and in the status bar, and all three clear together', async (t) => {
  const app = await start();
  try {
    await showTab(app, 'Inspector');
    assert.equal(await errorsShown(app), null);
    const pane = await boxOf(app, '[data-graph="root"]');

    // An import node without a file, from the palette: selected, it is what the viewport is asked to show, and it fails.
    await graphHover(app, { x: pane.x + pane.width * 0.75, y: pane.y + pane.height * 0.5 });
    await graphClick(app, { x: pane.x + pane.width * 0.75, y: pane.y + pane.height * 0.5 });
    await keyPress(app, 'Tab');
    await searchPalette(app, 'import height', 'io/import-field');
    const before = await docOf(app);
    await keyPress(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const imported = await addedNode(app, before);
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(imported)}]?.state === 'error'`, EVALUATION_BACKSTOP_MS);

    // ---- the three places ----
    await app.waitFor(`document.querySelector('[data-graph="root"] [data-node="${imported}"]').getAttribute('data-status') === 'error'`, PAGE_BACKSTOP_MS);
    const graph = await inGraph(app, imported);
    assert.equal(graph.line, 'No file selected');
    assert.equal(await attr(app, `[data-node="${imported}"]`, 'data-failed'), '');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-node="${imported}"] [data-badge="error"]') !== null`), true, 'the graph marks the node');
    await appears(app, `${INSPECTOR} [data-node-error]`);
    assert.equal(await text(app, `${INSPECTOR} [data-node-error] span`), 'No file selected');
    assert.equal((await inInspector(app)).state, 'error');
    await app.waitFor(`document.querySelector('[data-status="errors"]')?.classList.contains('og-status-error')`, PAGE_BACKSTOP_MS);
    assert.equal(await errorsShown(app), '1 node failed');
    assert.equal(await text(app, '[data-viewport="state"]'), 'Node failed', 'and the viewport says why its picture is not the node\'s');
    await capture(app, '07-error-in-three-places');
    // The list of errors names the node by its title and says the same sentence.
    await press(app, '[data-status="errors"]');
    await appears(app, `[data-error="node"][data-node="${imported}"]`);
    assert.ok((await text(app, `[data-error="node"][data-node="${imported}"]`))!.includes('No file selected'));
    await press(app, '[data-ui="dialog"][data-dialog="errors"] [data-action="ok"]');
    await vanishes(app, '[data-ui="dialog"][data-dialog="errors"]');

    // ---- a file that is not there: another sentence, in all three ----
    const missing = path.join(OUTPUT, 'gate-consistency-no-such-file.png');
    await app.eval(`void orogenTest.shell.answers.openFileDialog.push(${quote(missing)})`);
    await press(app, `${INSPECTOR} [data-control="file"] [data-action="browse"]`);
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      return state.evaluation === null && /^File not found/.test(state.nodes[${quote(imported)}]?.error?.message ?? '');
    })()`, EVALUATION_BACKSTOP_MS);
    await app.waitFor(`/^File not found/.test(document.querySelector('[data-graph="root"] [data-node="${imported}"] [data-role="status"]').textContent)`, PAGE_BACKSTOP_MS);
    await app.waitFor(`/^File not found/.test(document.querySelector('${INSPECTOR} [data-node-error] span')?.textContent ?? '')`, PAGE_BACKSTOP_MS);
    assert.equal(await errorsShown(app), '1 node failed');

    // ---- the file that is there: the node computes, and the error is gone from the graph, the inspector and the status bar ----
    const heights = path.join(ROOT, 'tests/graphs/assets/heights-253.png');
    await app.eval(`void orogenTest.shell.answers.openFileDialog.push(${quote(heights)})`);
    await press(app, `${INSPECTOR} [data-control="file"] [data-action="browse"]`);
    await settled(app);
    await app.waitFor(`['done', 'cached'].includes(document.querySelector('[data-graph="root"] [data-node="${imported}"]').getAttribute('data-status'))`, EVALUATION_BACKSTOP_MS);
    await app.waitFor(`document.querySelector('${INSPECTOR} [data-node-error]') === null`, PAGE_BACKSTOP_MS);
    await app.waitFor(`!document.querySelector('[data-status="errors"]')?.classList.contains('og-status-error')`, PAGE_BACKSTOP_MS);
    assert.equal(await attr(app, `[data-node="${imported}"]`, 'data-failed'), null);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-node="${imported}"] [data-badge="error"]') === null`), true);
    assert.match((await inInspector(app)).status, /^Computed/);
    assert.equal(await errorsShown(app), null);
    await app.waitFor(`!document.querySelector('[data-viewport="state"]')`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '[data-viewport="subject"]'), 'Import Heightmap');
    await capture(app, '08-error-cleared');

    // ---- undo brings the error back in all three, and deleting the node ends it in all three ----
    await keyPress(app, 'KeyZ', { ctrl: true });
    await app.waitFor(`document.querySelector('[data-graph="root"] [data-node="${imported}"]').getAttribute('data-status') === 'error'`, EVALUATION_BACKSTOP_MS);
    await appears(app, `${INSPECTOR} [data-node-error]`);
    await app.waitFor(`document.querySelector('[data-status="errors"]')?.classList.contains('og-status-error')`, PAGE_BACKSTOP_MS);
    await graphClick(app, await titleAt(app, imported));
    await keyPress(app, 'Delete');
    assert.equal(Object.hasOwn((await docOf(app)).nodes, imported), false);
    await app.waitFor(`!document.querySelector('[data-status="errors"]')?.classList.contains('og-status-error')`, EVALUATION_BACKSTOP_MS);
    await appears(app, `${INSPECTOR} [data-inspector-header="settings"]`);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-graph="root"] [data-failed]').length`), 0);
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});
