// What a newcomer meets in the first quarter of an hour, as the final review walked it: a project made from the
// library by the obvious words, a graph whose names can be read at the size an example opens in, a Help that
// opens, a project that does not show the terrain of the one before, and an engine that says when it has gone
// silent. Each of these was a finding of that review; each test here fails without its fix.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, attr, boxOf, capture, docOf, graphHover, graphSettled, graphWheel, history, keyPress, nodeBox, press, selection, selectNode, settled, showTab, start, text,
  typeInto, vanishes, EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, quote,
} from './gate-rig.ts';

const SHOTS = 'newcomer';
const wires = async (app: AppDriver): Promise<string[]> =>
  Object.values((await docOf(app)).edges).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`).sort();

/** Types into the library's search and adds the node it selects, as Enter does. Returns the new node's id. */
async function addFromLibrary(app: AppDriver, words: string, type: string): Promise<string> {
  await showTab(app, 'Library');
  await press(app, '[data-panel="library"] [data-tab="nodes"]');
  await appears(app, '[data-library="search"]');
  await press(app, '[data-library="search"]');
  await typeInto(app, '[data-library="search"]', words);
  await app.waitFor(`document.querySelector('[data-library="list"] [role="option"][aria-selected="true"]')?.getAttribute('data-node') === ${quote(type)}`, PAGE_BACKSTOP_MS);
  const before = await docOf(app);
  await keyPress(app, 'Enter', {}, '[data-library="search"]');
  await app.waitFor(`Object.keys(orogenTest.ctx.doc.getState().doc.nodes).length === ${Object.keys(before.nodes).length + 1}`, PAGE_BACKSTOP_MS);
  const after = await docOf(app);
  return Object.keys(after.nodes).find((id) => !Object.hasOwn(before.nodes, id))!;
}

/** Whether the boxes of two nodes share a point on screen. */
async function covers(app: AppDriver, one: string, other: string): Promise<boolean> {
  const a = await nodeBox(app, one), b = await nodeBox(app, other);
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('newcomer: a terrain made from the library by the obvious words is wired, readable and exports its heightmap', async (t) => {
  const app = await start();
  try {
    // The default project: one Mountain Range. A press on it selects it, as a first look does.
    const range = Object.keys((await docOf(app)).nodes)[0]!;
    await selectNode(app, range);

    // "erosion", Enter: the new node continues from the selected one and covers nothing.
    const erosion = await addFromLibrary(app, 'erosion', 'simulate/fluvial-erosion');
    assert.deepEqual(await wires(app), [`${range}.out>${erosion}.in`], 'the selected node feeds the new one');
    assert.equal(await covers(app, range, erosion), false, 'the new node does not lie on the node that was there');
    assert.deepEqual(await selection(app), [erosion]);
    assert.deepEqual(await history(app), ['Add Fluvial Erosion'], 'one step: Ctrl+Z takes the node and its wire back');
    await settled(app, 4 * EVALUATION_BACKSTOP_MS);
    assert.equal(await text(app, '[data-status="errors"]'), null, 'no node lacks an input, and none failed');
    assert.equal(await attr(app, '[data-viewport="root"]', 'data-status'), 'shown', 'the viewport shows the eroded terrain, not "Missing input"');

    // "export", Enter: the node that exports the terrain, wired to the erosion. It was a Color Texture.
    const exported = await addFromLibrary(app, 'export', 'io/export-landscape');
    assert.deepEqual(await wires(app), [`${erosion}.out>${exported}.in`, `${range}.out>${erosion}.in`].sort());
    for (const other of [range, erosion]) assert.equal(await covers(app, exported, other), false, `the export does not cover ${other}`);
    const graph = await boxOf(app, '[data-graph="root"]');
    const landed = await nodeBox(app, exported);
    assert.ok(landed.x >= graph.x && landed.x + landed.width <= graph.x + graph.width, `the new node was brought into view: ${JSON.stringify(landed)}`);
    t.diagnostic(`capture: ${await capture(app, SHOTS, '01-three-nodes-from-the-library')}`);

    // The plan of the project as it is: the heightmap is among its files, and nothing warns that it is missing.
    await showTab(app, 'Build');
    await appears(app, '[data-panel="build"] [data-build="plan-targets"]');
    await app.waitFor(`document.querySelector('[data-build-file="OrogenHeight.png"]') !== null`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build-note="plan-no-landscape"]') === null`), true);

    // The same project with a colour texture in the export's place: it would "finish", and the panel says what it lacks.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Texture instead', (draft) => {
      draft.nodes[${quote(exported)}].params.enabled = false;
      draft.nodes.tex = { id: 'tex', type: 'io/export-normal', version: 1, position: { x: 2000, y: 600 }, params: {} };
      draft.edges.totex = { id: 'totex', from: { node: ${quote(erosion)}, port: 'out' }, to: { node: 'tex', port: 'in' } };
    })`);
    await appears(app, '[data-build-note="plan-no-landscape"]');
    assert.match((await text(app, '[data-build-note="plan-no-landscape"]'))!, /^No Unreal Landscape node: this build writes no heightmap\./);
    assert.equal(await text(app, '[data-build="plan-total"]'), '2 filessized when written', 'no "0 B and": none of these files has a size before it is written');
    t.diagnostic(`capture: ${await capture(app, SHOTS, '02-plan-without-a-landscape')}`);
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('newcomer: the names in the graph can be read at every zoom they are drawn at, and Help opens in the application', async (t) => {
  const app = await start({ open: 'examples/desert-canyons.orogen' });
  try {
    await graphSettled(app);
    /** The zoom, the level of detail, and the height of every node's name on screen. */
    const names = (): Promise<{ zoom: number; lod: string; step: string | null; heights: number[]; cut: number }> => app.eval(`(() => {
      const root = document.querySelector('[data-graph="root"]');
      const zoom = graphTest.drawn().zoom;
      const titles = [...root.querySelectorAll('[data-node] [data-role="title"]')].filter((title) => getComputedStyle(title).display !== 'none');
      return {
        zoom, lod: root.getAttribute('data-lod'), step: root.getAttribute('data-title-step'),
        heights: titles.map((title) => parseFloat(getComputedStyle(title).fontSize) * zoom),
        cut: titles.filter((title) => { const box = title.getBoundingClientRect(), node = title.closest('[data-node]').getBoundingClientRect(); return box.left < node.left - 1 || box.right > node.right + 1; }).length,
      };
    })()`);

    // This example opens fitted into the middle band, where a name was 4.8 pixels high.
    const opened = await names();
    assert.equal(opened.lod, 'mid', `Desert Canyons is fitted at ${opened.zoom}`);
    assert.ok(opened.heights.length > 10 && Math.min(...opened.heights) >= 8.8, `the names as the example opens: ${Math.min(...opened.heights).toFixed(1)} px at a zoom of ${opened.zoom.toFixed(3)}`);
    assert.equal(opened.cut, 0, 'every name is cut at its node, and covers no neighbour');
    t.diagnostic(`capture: ${await capture(app, SHOTS, '03-example-opened-in-the-middle-band')}`);

    // Through the band and beyond it, a wheel step at a time: wherever a name is drawn it reads.
    const graph = await boxOf(app, '[data-graph="root"]');
    const over = { x: graph.x + graph.width / 2, y: graph.y + graph.height / 2 };
    await graphHover(app, over);
    const seen: string[] = [];
    for (let tick = 0; tick < 40; tick++) {
      const now = await names();
      if (now.heights.length > 0) {
        assert.ok(Math.min(...now.heights) >= 8.8, `at a zoom of ${now.zoom.toFixed(3)} (${now.lod}, ${now.step}) a name is ${Math.min(...now.heights).toFixed(1)} px high`);
        if (!seen.includes(`${now.lod}:${now.step}`)) seen.push(`${now.lod}:${now.step}`);
      }
      if (now.zoom >= 1) break;
      await graphWheel(app, over, -40);
    }
    assert.deepEqual(seen.filter((entry) => entry !== 'mid:low'), ['mid:high', 'near:near', 'near:null'], `the steps the zoom went through: ${seen.join(', ')}`);

    // Help > User Guide: the page, in the application. No program of the system is asked for it.
    await app.eval(`void orogenTest.ctx.run('help.userGuide')`);
    await appears(app, '[data-dialog="help"]');
    assert.equal(await attr(app, '[data-ui="help"]', 'data-help-page'), 'README.md');
    assert.equal(await text(app, '[data-help="text"] h1'), 'Orogen user guide');
    assert.ok((await app.eval<number>(`document.querySelectorAll('[data-help="text"] table tr').length`)) > 5, 'its table is a table, not bars');
    // A link to another page opens that page here, at the heading it names; Back returns.
    await press(app, '[data-help="text"] [data-help-link="getting-started.md#2-from-the-repository"]');
    await app.waitFor(`document.querySelector('[data-ui="help"]').getAttribute('data-help-page') === 'getting-started.md'`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-help-anchor="2-from-the-repository"]') !== null`), true);
    assert.ok((await app.eval<number>(`document.querySelectorAll('[data-help="text"] img').length`)) >= 1, 'the page shows its picture');
    t.diagnostic(`capture: ${await capture(app, SHOTS, '04-help-getting-started')}`);
    await press(app, '[data-dialog="help"] [data-action="back"]');
    await app.waitFor(`document.querySelector('[data-ui="help"]').getAttribute('data-help-page') === 'README.md'`, PAGE_BACKSTOP_MS);
    await press(app, '[data-dialog="help"] [data-action="close"]');
    await vanishes(app, '[data-dialog="help"]');
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('newcomer: a project whose shown node fails does not show the terrain of the project before, and its nodes bear nothing of that project', async (t) => {
  const app = await start({ open: 'examples/alpine-range.orogen' });
  try {
    await settled(app, 4 * EVALUATION_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="cover"]') === null`), true, 'the alpine terrain is shown');
    assert.ok((await app.eval<number>(`Object.keys(orogenTest.ctx.engineState.getState().nodes).length`)) >= 10);

    // Another project: an import whose file was never chosen, shown, with a node that bears an id of the alpine example.
    await app.eval(`void orogenTest.ctx.doc.getState().load({
      format: 'orogen', version: 1,
      settings: { terrainSize: 4032, heightRange: 1008, seed: 1, buildResolution: 4033, previewLevel: 2, seaLevel: 0 },
      nodes: {
        snow: { id: 'snow', type: 'io/import-field', version: 1, position: { x: 0, y: 0 }, params: {} },
        rock: { id: 'rock', type: 'io/export-landscape', version: 1, position: { x: 400, y: 0 }, params: {} },
      },
      edges: { e: { id: 'e', from: { node: 'snow', port: 'out' }, to: { node: 'rock', port: 'in' } } },
      groups: {}, ui: { view: { height: { node: 'snow', port: 'out' } } },
    }, null)`);
    // At once, before the engine has said anything of the new project: nothing of the one before is left.
    assert.deepEqual(await app.eval<unknown[]>(`(() => { const e = orogenTest.ctx.engineState.getState(); return [e.view, Object.keys(e.nodes).filter((id) => e.nodes[id].state === 'done')]; })()`), [null, []]);
    await app.waitFor(`orogenTest.ctx.engineState.getState().nodes.snow?.state === 'error' && orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    const shown = await app.eval<{ view: unknown; cover: string | null; status: string | null; error: string | null }>(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      return {
        view: engine.view, cover: document.querySelector('[data-viewport="cover"]')?.textContent ?? null,
        status: document.querySelector('[data-viewport="root"]').getAttribute('data-status'), error: engine.nodes.snow.error?.message ?? null,
      };
    })()`);
    assert.deepEqual([shown.view, shown.status, shown.error], [null, 'error', 'No file selected']);
    assert.match(shown.cover ?? '', /^The shown node failed/, 'the canvas is covered: the alpine terrain under it is no picture of this project');
    t.diagnostic(`capture: ${await capture(app, SHOTS, '05-failed-node-covers-the-old-terrain')}`);

    // What went wrong is one sentence; the stack behind it is folded away.
    await app.eval(`void orogenTest.ctx.run('view.showErrors')`);
    await appears(app, '[data-dialog="errors"] [data-error="node"]');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-dialog="errors"] [data-error="details"]').open`), false, 'the details are closed until asked for');
    assert.match((await text(app, '[data-dialog="errors"] [data-error="node"] .og-list-title'))!, /^Import Heightmap: No file selected$/);
    t.diagnostic(`capture: ${await capture(app, SHOTS, '06-errors-with-details-folded')}`);
  } finally {
    await app.close().catch(() => {});
  }
});

test('newcomer: an engine whose worker has ended is said in the status bar, with the button that starts another', { timeout: 180_000 }, async (t) => {
  const app = await start();
  try {
    assert.equal(await text(app, '[data-status="device"]'), 'Ready');
    // As a crash of its thread leaves it: no event, and no answer to anything (ARCHITECTURE.md, section 2).
    await app.eval(`void orogenTest.shell.engineWorker().terminate()`);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = 5; })`);
    // Asked after five seconds of silence, called silent when that question has stood for fifteen (8.5).
    await app.waitFor(`orogenTest.ctx.engineState.getState().silent === true`, 60_000);
    assert.equal(await text(app, '[data-status="device"]'), 'Engine not respondingRestart Engine');
    // Taken of the window as it is: the engine answers no pick for the rig's own capture to wait on.
    t.diagnostic(`capture: ${await app.capture(`${SHOTS}/07-engine-not-responding`)}`);
    await press(app, '[data-status="device"] [data-command="engine.restart"]');
    await app.waitFor(`(() => { const e = orogenTest.ctx.engineState.getState(); return e.device.state === 'ready' && !e.silent; })()`, 60_000);
    await settled(app, 2 * EVALUATION_BACKSTOP_MS);
    assert.equal(await text(app, '[data-status="device"]'), 'Ready');
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().doc.settings.seed`), 5, 'the project was never in the engine');
  } finally {
    await app.close().catch(() => {});
  }
});
