// A small terrain graph built in the window by input alone, as a person builds it: a node from the palette, a
// wire dragged between two ports, a node moved, renamed, bypassed, duplicated and deleted, and every one of
// those undone and redone by its key. Then a wire dropped on the canvas, which opens the palette for it.
//
// The captures are written for a person (testing.md 8.5 rule 1): graph/build-01 … build-07.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  added, appears, attr, capture, click, docked, docOf, drag, focusGraph, graphBox, graphSettled, history, key, near, nodeBox, nodeSelector, PAGE_BACKSTOP_MS, port, quote,
  ready, redo, selection, settled, text, titleOf, undo, vanishes, wires, withApp,
} from './rig.ts';

const REGISTRY = createRegistry(nodes);
const PALETTE = '[data-graph="palette"]';
const zoomOf = (app: AppDriver): Promise<number> => app.eval<number>(`graphTest.viewport()?.zoom ?? 1`);

/** Types into the palette's search and waits for the list to follow. */
async function search(app: AppDriver, query: string, first: string): Promise<void> {
  await app.eval(`void shellTest.type(${quote(`${PALETTE} input`)}, ${quote(query)})`);
  await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === ${quote(first)}`, PAGE_BACKSTOP_MS);
}

test('build: a terrain graph made by input alone, each step undone and redone', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    await graphSettled(app);
    await focusGraph(app);

    // ---- the default project: one node, drawn as the document and the engine say ----
    const start = await docOf(app);
    const range = Object.keys(start.nodes)[0]!;
    await app.waitFor(`document.querySelector(${quote(`${nodeSelector(range)} [data-thumbnail="drawn"]`)}) !== null`, PAGE_BACKSTOP_MS);
    const first = await app.eval<{ title: string; category: string; status: string; shown: string | null; ports: string[]; lod: string }>(`(() => {
      const node = document.querySelector(${quote(nodeSelector(range))});
      return {
        title: node.querySelector('[data-role="title"]').textContent, category: node.getAttribute('data-category'), status: node.getAttribute('data-status'),
        shown: node.getAttribute('data-shown'), ports: [...node.querySelectorAll('[data-port]')].map((p) => p.textContent || p.getAttribute('data-tone')),
        lod: document.querySelector('[data-graph="root"]').getAttribute('data-lod'),
      };
    })()`);
    assert.deepEqual(first, { title: 'Mountain Range', category: 'generate', status: first.status, shown: 'terrain', ports: ['Out', 'height'], lod: 'near' });
    assert.ok(['done', 'cached'].includes(first.status), `the node is computed: ${first.status}`);
    // What the style sheet draws is what geometry.ts computes: the library is told the size and never measures it.
    const drawn = await app.eval<{ height: number; width: number; told: { width: number; height: number } }>(`(() => {
      const wrapper = document.querySelector(${quote(nodeSelector(range))}).parentElement;
      return { height: wrapper.offsetHeight, width: wrapper.offsetWidth, told: { width: parseFloat(wrapper.style.width), height: parseFloat(wrapper.style.height) } };
    })()`);
    assert.deepEqual([drawn.width, drawn.height], [drawn.told.width, drawn.told.height]);
    assert.ok((await docOf(app)).ui.graphViewport !== undefined, 'the graph was fitted and its viewport is in the document');
    // With the whole graph in view the minimap would only cover a part of it: it is not drawn.
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__minimap') === null`), true);
    t.diagnostic(`capture: ${await capture(app, 'build-01-default-project')}`);

    // ---- a node from the palette: Tab, a few letters, Enter ----
    const box = await graphBox(app);
    const rangeBox = await nodeBox(app, range);
    assert.ok(rangeBox.x > box.x && rangeBox.y > box.y && rangeBox.x + rangeBox.width < box.x + box.width && rangeBox.y + rangeBox.height < box.y + box.height, 'the one node of the project lies inside the panel');
    near(rangeBox.x + rangeBox.width / 2, box.x + box.width / 2, 2, 'fitted: in the middle of the panel');
    const free = { x: rangeBox.x + rangeBox.width + 240, y: rangeBox.y + 60 };
    await app.eval(`void graphTest.hover(${free.x}, ${free.y})`);
    await key(app, 'Tab');
    await appears(app, PALETTE);
    assert.equal(await app.eval<number>(`document.querySelectorAll(${quote(`${PALETTE} [role="option"][data-type]`)}).length`), REGISTRY.list().filter((def) => def.category !== 'ref').length, 'every node of the product is listed, and no reference node');
    assert.ok((await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PALETTE} [data-role="categories"] [role="option"]`)})].map((e) => e.getAttribute('data-category'))`)).includes('simulate'));
    await search(app, 'terr', 'surface/terraces');
    const described = await text(app, `${PALETTE} [data-role="description"]`);
    assert.ok(described?.startsWith(REGISTRY.get('surface/terraces')!.description), `the description of the highlighted node: ${described}`);
    t.diagnostic(`capture: ${await capture(app, 'build-02-palette')}`);
    await key(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const [terraces] = await added(app, start);
    assert.ok(terraces, 'a node was added');
    let doc = await docOf(app);
    assert.equal(doc.nodes[terraces]!.type, 'surface/terraces');
    assert.deepEqual(await selection(app), [terraces], 'the new node is selected');
    assert.deepEqual(await history(app), ['Add Terraces']);
    // It lies where the pointer was: its middle under it.
    const placed = await nodeBox(app, terraces);
    near(placed.x + placed.width / 2, free.x, 2, 'the node\'s middle, x');
    near(placed.y + placed.height / 2, free.y, 2, 'the node\'s middle, y');
    // Unconnected, it says what it lacks: the engine sends no event for it that the graph could wait for.
    assert.equal(await attr(app, nodeSelector(terraces), 'data-status'), 'missing');
    assert.equal(await text(app, `${nodeSelector(terraces)} [data-role="status"]`), 'Missing input: In');

    await undo(app);
    assert.equal(Object.hasOwn((await docOf(app)).nodes, terraces), false);
    await vanishes(app, nodeSelector(terraces));
    await redo(app);
    await appears(app, nodeSelector(terraces));
    assert.deepEqual(await selection(app), [terraces]);

    // ---- a wire, dragged from an output to an input ----
    await drag(app, await port(app, range, 'out', 'out'), await port(app, terraces, 'in', 'in'));
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`]);
    assert.deepEqual(await history(app), ['Add Terraces', 'Connect']);
    await app.waitFor(`document.querySelectorAll('.react-flow__edge').length === 1`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`document.querySelector('.react-flow__edge path[data-tone]').getAttribute('data-tone')`), 'height', 'the wire has the colour of a terrain');
    await undo(app);
    assert.deepEqual(await wires(app), []);
    await redo(app);
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`]);
    // Connected, the node is computed and shown: selecting it made it the terrain of the viewport (7.4).
    await settled(app);
    await app.waitFor(`['done', 'cached'].includes(document.querySelector(${quote(nodeSelector(terraces))}).getAttribute('data-status'))`, PAGE_BACKSTOP_MS);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: terraces, port: 'out' } });
    assert.equal(await attr(app, nodeSelector(terraces), 'data-shown'), 'terrain');
    assert.equal(await attr(app, nodeSelector(range), 'data-shown'), null);
    t.diagnostic(`capture: ${await capture(app, 'build-03-connected')}`);

    // ---- move: one gesture, one step ----
    const zoom = await zoomOf(app);
    const before = (await docOf(app)).nodes[terraces]!.position;
    const grip = await titleOf(app, terraces);
    await drag(app, grip, { x: grip.x + 90, y: grip.y + 60 }, {}, 12);
    doc = await docOf(app);
    near(doc.nodes[terraces]!.position.x, before.x + 90 / zoom, 4, 'moved along x by the drag');
    near(doc.nodes[terraces]!.position.y, before.y + 60 / zoom, 4, 'moved along y by the drag');
    assert.deepEqual(await history(app), ['Add Terraces', 'Connect', 'Move'], 'a dozen pointer moves are one step');
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.ui.getState().dragPositions`), null, 'the drag left nothing behind in uiStore');
    const moved = await nodeBox(app, terraces);
    near(moved.x, placed.x + 90, 4, 'drawn where it was dropped');
    await undo(app);
    assert.deepEqual((await docOf(app)).nodes[terraces]!.position, before);
    await redo(app);
    assert.deepEqual((await docOf(app)).nodes[terraces]!.position, doc.nodes[terraces]!.position);

    // ---- rename: F2, the name, Enter ----
    await key(app, 'F2');
    const field = `${nodeSelector(terraces)} [data-graph="rename"]`;
    await appears(app, field);
    assert.equal(await app.eval<string>(`document.querySelector(${quote(field)}).value`), 'Terraces');
    await app.eval(`void shellTest.type(${quote(field)}, 'Rice Paddies')`);
    await key(app, 'Enter', {}, field);
    await vanishes(app, field);
    assert.equal((await docOf(app)).nodes[terraces]!.title, 'Rice Paddies');
    assert.equal(await text(app, `${nodeSelector(terraces)} [data-role="title"]`), 'Rice Paddies');
    assert.equal((await history(app)).at(-1), 'Rename');
    await undo(app);
    assert.equal(await text(app, `${nodeSelector(terraces)} [data-role="title"]`), 'Terraces');
    await redo(app);
    assert.equal(await text(app, `${nodeSelector(terraces)} [data-role="title"]`), 'Rice Paddies');
    // Escape leaves the name as it was.
    await key(app, 'F2');
    await appears(app, field);
    await app.eval(`void shellTest.type(${quote(field)}, 'Something else')`);
    await key(app, 'Escape', {}, field);
    await vanishes(app, field);
    assert.equal((await docOf(app)).nodes[terraces]!.title, 'Rice Paddies');

    // ---- bypass: B ----
    await key(app, 'KeyB');
    assert.equal((await docOf(app)).nodes[terraces]!.bypass, true);
    await app.waitFor(`document.querySelector(${quote(nodeSelector(terraces))}).getAttribute('data-status') === 'bypassed'`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, `${nodeSelector(terraces)} [data-role="status"]`), 'Bypassed');
    assert.equal(await attr(app, nodeSelector(terraces), 'data-bypassed'), '');
    t.diagnostic(`capture: ${await capture(app, 'build-04-renamed-and-bypassed')}`);
    await undo(app);
    assert.equal((await docOf(app)).nodes[terraces]!.bypass, undefined);
    await redo(app);
    assert.equal((await docOf(app)).nodes[terraces]!.bypass, true);
    await key(app, 'KeyB');
    assert.equal((await docOf(app)).nodes[terraces]!.bypass, undefined, 'B again takes the bypass off');

    // ---- duplicate: Ctrl+D ----
    const single = await docOf(app);
    await key(app, 'KeyD', { ctrl: true });
    const [copy] = await added(app, single);
    assert.ok(copy);
    doc = await docOf(app);
    assert.deepEqual([doc.nodes[copy]!.type, doc.nodes[copy]!.title], ['surface/terraces', 'Rice Paddies']);
    assert.deepEqual(await selection(app), [copy], 'the copy is selected');
    assert.equal((await history(app)).at(-1), 'Duplicate');
    await appears(app, nodeSelector(copy));
    await undo(app);
    await vanishes(app, nodeSelector(copy));
    assert.deepEqual(await selection(app), [terraces]);
    await redo(app);
    await appears(app, nodeSelector(copy));

    // ---- delete: the Delete key ----
    await key(app, 'Delete');
    assert.equal(Object.hasOwn((await docOf(app)).nodes, copy), false);
    await vanishes(app, nodeSelector(copy));
    assert.equal((await history(app)).at(-1), 'Delete');
    await undo(app);
    await appears(app, nodeSelector(copy));
    await redo(app);
    await vanishes(app, nodeSelector(copy));
    assert.deepEqual(Object.keys((await docOf(app)).nodes).sort(), [range, terraces].sort());
    // What the viewport showed was the copy, and the view is left as it is when its node goes (4.6): nothing is
    // shown until a node is selected. A click on one selects it and shows it (7.4).
    assert.deepEqual([await selection(app), (await docOf(app)).ui.view], [[], { height: { node: copy, port: 'out' } }]);
    await click(app, await titleOf(app, terraces));
    assert.deepEqual(await selection(app), [terraces]);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.view?.height?.node === ${quote(terraces)}`, PAGE_BACKSTOP_MS);

    // ---- room for a third node: the graph is panned with the middle button ----
    const held = (await docOf(app)).ui.graphViewport!;
    const pane = await graphBox(app);
    const empty = { x: pane.x + 200, y: pane.y + 120 };
    await drag(app, empty, { x: empty.x - 260, y: empty.y - 60 }, { button: 1 });
    await app.waitFor(`Math.abs(graphTest.viewport().x - ${held.x - 260}) < 4 && Math.abs(graphTest.viewport().y - ${held.y - 60}) < 4`, PAGE_BACKSTOP_MS);
    assert.equal((await docOf(app)).ui.graphViewport!.zoom, held.zoom, 'panning does not zoom');
    assert.equal((await history(app)).at(-1), 'Delete', 'the graph\'s viewport is kept in the document and is no step of the history');
    // Both nodes are still in the panel: no minimap is drawn for a graph that is in view (editing.test.ts has the rest of it).
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__minimap') === null`), true);

    // ---- a wire dropped on the empty canvas opens the palette for it, and the node chosen is connected ----
    const out = await port(app, terraces, 'out', 'out');
    const drop = { x: out.x + 60, y: out.y + 90 };
    const steps = (await history(app)).length;
    await drag(app, out, drop);
    await appears(app, PALETTE);
    assert.equal(await text(app, `${PALETTE} [data-role="wire"]`), 'From Rice Paddies: Out');
    const offered = await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PALETTE} [role="option"][data-type]`)})].map((e) => e.getAttribute('data-type'))`);
    assert.ok(offered.length < REGISTRY.list().length && !offered.includes('generate/mountain-range') && offered.includes('filter/blur'), 'only nodes the wire can end at');
    await search(app, 'slope', 'select/slope');
    t.diagnostic(`capture: ${await capture(app, 'build-05-palette-for-a-wire')}`);
    await key(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const [slope] = (await added(app, single)).filter((id) => id !== copy);
    assert.ok(slope);
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`, `${terraces}.out>${slope}.in`].sort());
    assert.deepEqual((await history(app)).slice(steps), ['Add Slope'], 'the node and its wire are one step');
    // Its input port lies where the wire was dropped.
    const input = await port(app, slope, 'in', 'in');
    near(input.x, drop.x, 3, 'the new node\'s port, x');
    near(input.y, drop.y, 3, 'the new node\'s port, y');
    await settled(app);
    // A mask selected lies over the terrain that is shown (7.4): both nodes say what they are to the viewport.
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: terraces, port: 'out' }, overlay: { ref: { node: slope, port: 'out' }, as: 'mask', opacity: 1 } });
    assert.deepEqual([await attr(app, nodeSelector(terraces), 'data-shown'), await attr(app, nodeSelector(slope), 'data-shown')], ['terrain', 'overlay']);
    await app.waitFor(`document.querySelector(${quote(`${nodeSelector(slope)} [data-thumbnail="drawn"]`)}) !== null`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`document.querySelector(${quote(`${nodeSelector(slope)} .react-flow__handle[data-side="out"]`)}).getAttribute('data-tone')`), 'mask');
    t.diagnostic(`capture: ${await capture(app, 'build-06-three-nodes')}`);
    await undo(app);
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`]);
    await redo(app);
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`, `${terraces}.out>${slope}.in`].sort());

    // ---- a click on a node selects it and shows it; a click on the canvas selects nothing ----
    await click(app, await titleOf(app, range));
    assert.deepEqual(await selection(app), [range]);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: range, port: 'out' } });
    await settled(app);
    const paneBox = await graphBox(app);
    await click(app, { x: paneBox.x + paneBox.width - 40, y: paneBox.y + 60 });
    assert.deepEqual(await selection(app), []);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: range, port: 'out' } }, 'the view stays when nothing is selected');
    t.diagnostic(`capture: ${await capture(app, 'build-07-final')}`);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), true);

    // ---- with its last node gone the graph says how to begin again ----
    await key(app, 'KeyA', { ctrl: true });
    assert.equal((await selection(app)).length, 3);
    await key(app, 'Backspace');
    assert.deepEqual(Object.keys((await docOf(app)).nodes), []);
    await appears(app, '[data-graph="empty"]');
    assert.match(await text(app, '[data-graph="empty"]') ?? '', /^The graph is emptyPress Tab to add a node, or drag one in from the library$/);
    await undo(app);
    await vanishes(app, '[data-graph="empty"]');
    assert.equal(Object.keys((await docOf(app)).nodes).length, 3);
    assert.deepEqual((await wires(app)).length, 2, 'the wires came back with the nodes');
  });
});
