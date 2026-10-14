// The graph edited by input alone on acceptance graph 03 (five nodes, six wires): selecting by click, by
// Shift and by a box; the context menus of a node, a wire and the canvas; a connection that is refused and why;
// wires cut by a stroke; groups; fitting, zooming and panning; nodes from the library, dropped on the canvas
// and on a wire; and every command of the panel, by its key or its menu.
//
// The captures are written for a person (testing.md 8.5 rule 1): graph/editing-01 … editing-08.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppDriver } from '../../helpers/index.ts';
import { openMenu } from '../shell/rig.ts';
import {
  added, appears, attr, capture, chooseItem, click, docked, docOf, drag, drawn, focusGraph, graphBox, graphSettled, history, key, menuItems, near, nodeBox,
  nodeSelector, PAGE_BACKSTOP_MS, port, quote, ready, redo, secondary, selection, settled, sleep, text, titleOf, undo, vanishes, wireAt, wires, withApp,
  type Point,
} from './rig.ts';

const GRAPH = 'tests/graphs/03-simulate.orogen';
const ALL_WIRES = ['fbm.out>mixed.b', 'fbm.out>talus.in', 'steep.out>dist.in', 'talus.moved>mixed.mask', 'talus.out>mixed.a', 'talus.out>steep.in'];
const PALETTE = '[data-graph="palette"]';
const REFUSAL = '[data-graph="refusal"]';

async function open(app: AppDriver): Promise<void> {
  await ready(app);
  await docked(app);
  await graphSettled(app);
  await focusGraph(app);
}

/** A point of the canvas with nothing on it: under the first node, which has no node below it. */
async function emptySpot(app: AppDriver): Promise<Point> {
  const fbm = await nodeBox(app, 'fbm');
  return { x: fbm.x + fbm.width / 2, y: fbm.y + fbm.height + 70 };
}

test('editing: selection, context menus, a refused connection and cut wires', async (t) => {
  await withApp({ open: GRAPH }, async (app) => {
    await open(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge').length`), 6);
    const zoom = (await drawn(app)).zoom;
    assert.ok(zoom > 0.6 && zoom <= 1, `the five nodes are fitted into the panel at a zoom one can read: ${zoom}`);

    // ---- a click selects one node and shows it; Shift adds; a click on the canvas selects nothing ----
    await click(app, await titleOf(app, 'talus'));
    assert.deepEqual(await selection(app), ['talus']);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.view?.height?.node === 'talus'`, PAGE_BACKSTOP_MS);
    assert.equal(await attr(app, nodeSelector('talus'), 'data-selected'), '');
    await app.eval(`void graphTest.keyDown('ShiftLeft', 'Shift', { shiftKey: true })`);
    await click(app, await titleOf(app, 'mixed'), { shiftKey: true });
    await app.eval(`void graphTest.keyUp('ShiftLeft', 'Shift')`);
    assert.deepEqual(await selection(app), ['talus', 'mixed']);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'talus', port: 'out' } }, 'two nodes selected: the view stays (7.4)');
    await settled(app);
    await click(app, await emptySpot(app));
    assert.deepEqual(await selection(app), []);

    // ---- a box drawn on the canvas selects what it touches ----
    const [steep, dist] = [await nodeBox(app, 'steep'), await nodeBox(app, 'dist')];
    await drag(app, { x: steep.x - 30, y: steep.y + steep.height + 20 }, { x: dist.x + 40, y: steep.y + 40 }, {}, 10, false);
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__selection') !== null`), true, 'the box is drawn while the button is down');
    t.diagnostic(`capture: ${await capture(app, 'editing-01-selection-box')}`);
    // On its way to two nodes the box held one alone: the view does not follow a box that is still being drawn.
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'talus', port: 'out' } });
    await app.eval(`void graphTest.up(${dist.x + 40}, ${steep.y + 40})`);
    assert.deepEqual(await selection(app), ['steep', 'dist']);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'talus', port: 'out' } }, 'two nodes boxed: the view stays (7.4)');
    // A box around one node alone shows that node when the box is done, as a click on it does.
    await click(app, await emptySpot(app));
    await drag(app, { x: dist.x + dist.width + 20, y: dist.y + dist.height + 20 }, { x: dist.x + dist.width - 30, y: dist.y + dist.height - 30 }, {}, 6, false);
    assert.deepEqual(await selection(app), ['dist']);
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'talus', port: 'out' } });
    await app.eval(`void graphTest.up(${dist.x + dist.width - 30}, ${dist.y + dist.height - 30})`);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.view?.overlay?.ref.node === 'dist'`, PAGE_BACKSTOP_MS);
    await drag(app, { x: steep.x - 30, y: steep.y + steep.height + 20 }, { x: dist.x + 40, y: steep.y + 40 }, {}, 10);
    assert.deepEqual(await selection(app), ['steep', 'dist']);
    // Mod+A selects every node.
    await key(app, 'KeyA', { ctrl: true });
    assert.deepEqual((await selection(app)).sort(), ['dist', 'fbm', 'mixed', 'steep', 'talus']);
    await click(app, await emptySpot(app));
    assert.deepEqual(await selection(app), []);

    // ---- the context menu of a node: it selects the node and offers what can be done with it ----
    await secondary(app, await titleOf(app, 'talus'));
    await appears(app, '[data-ui="menu"]');
    assert.deepEqual(await selection(app), ['talus']);
    const nodeMenu = await menuItems(app);
    assert.deepEqual(nodeMenu.map((item) => item.id), [
      'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', 'graph.useAsTerrain', 'graph.toggleViewLock', 'edit.cut', 'edit.copy', 'graph.duplicate', 'graph.delete', 'graph.group',
    ]);
    assert.ok(nodeMenu.every((item) => item.enabled), 'every item can be chosen for a node that can be bypassed');
    t.diagnostic(`capture: ${await capture(app, 'editing-02-node-menu')}`);
    await chooseItem(app, 'graph.toggleBypass');
    assert.equal((await docOf(app)).nodes.talus!.bypass, true);
    await undo(app);
    assert.equal((await docOf(app)).nodes.talus!.bypass, undefined);

    // ---- the context menu of a wire: delete it ----
    await secondary(app, await wireAt(app, 'talus-out-steep-in'));
    await appears(app, '[data-ui="menu"]');
    // Its items are commands of the panel, as those of a node are: they act on the wire the press selected.
    assert.deepEqual((await menuItems(app)).map((item) => [item.id, item.label, item.enabled]), [['graph.insertNode', 'Insert Node…', true], ['graph.delete', 'Delete', true]]);
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__edge[data-id="e-talus-out-steep-in"]').classList.contains('selected')`), true, 'the wire is selected');
    assert.deepEqual(await selection(app), [], 'and no node is');
    await chooseItem(app, 'graph.delete');
    assert.deepEqual(await wires(app), ALL_WIRES.filter((wire) => wire !== 'talus.out>steep.in'));
    assert.equal((await history(app)).at(-1), 'Delete Wire');
    // Its input now lacks a wire, and the node says so although no evaluation names it.
    assert.equal(await text(app, `${nodeSelector('steep')} [data-role="status"]`), 'Missing input: In');
    assert.equal(await attr(app, `${nodeSelector('steep')} .react-flow__handle[data-side="in"]`, 'data-missing'), '');
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
    // A wire is also selected by a click and deleted by the key.
    await click(app, await wireAt(app, 'steep-out-dist-in'));
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__edge[data-id="e-steep-out-dist-in"]').classList.contains('selected')`), true);
    await key(app, 'Delete');
    assert.deepEqual(await wires(app), ALL_WIRES.filter((wire) => wire !== 'steep.out>dist.in'));
    await undo(app);

    // ---- the context menu of the canvas: add a node there ----
    const spot = await emptySpot(app);
    await secondary(app, spot);
    await appears(app, '[data-ui="menu"]');
    assert.deepEqual((await menuItems(app)).map((item) => item.id), ['graph.addNode', 'edit.paste', 'graph.selectAll', 'graph.fit', 'graph.toggleMinimap']);
    await chooseItem(app, 'graph.addNode');
    await appears(app, PALETTE);
    const palette = await app.eval<{ x: number; y: number }>(`graphTest.box(${quote(PALETTE)})`);
    near(palette.x, spot.x, 2, 'the palette opens where the menu was opened');
    await key(app, 'Escape', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);

    // ---- a connection that the document's rules refuse says why, and changes nothing (4.3) ----
    const held = await docOf(app);
    const [from, into] = [await port(app, 'dist', 'out', 'out'), await port(app, 'talus', 'in', 'in')];
    await drag(app, from, into, {}, 10, false);
    await appears(app, REFUSAL);
    assert.equal(await text(app, REFUSAL), 'The connection would create a cycle');
    t.diagnostic(`capture: ${await capture(app, 'editing-03-refused-connection')}`);
    await app.eval(`void graphTest.up(${into.x}, ${into.y})`);
    assert.equal(await text(app, REFUSAL), 'The connection would create a cycle', 'the reason stays for a moment after the wire was dropped');
    assert.deepEqual(await wires(app), ALL_WIRES);
    assert.equal((await history(app)).length, 0, 'every step so far was undone, and the refused wire is none');
    assert.ok(JSON.stringify((await docOf(app)).edges) === JSON.stringify(held.edges));
    await vanishes(app, REFUSAL);
    // Two outputs: the library asks nobody, and the graph still says why.
    const other = await port(app, 'steep', 'out', 'out');
    await drag(app, from, other, {}, 10, false);
    await appears(app, REFUSAL);
    assert.equal(await text(app, REFUSAL), 'An output connects to an input, not to another output');
    await app.eval(`void graphTest.up(${other.x}, ${other.y})`);
    assert.deepEqual(await wires(app), ALL_WIRES);
    // A wire let go over a node, off its ports, goes to an input of that node that is free. This one has none:
    // the graph says so, takes over no input that has a wire, and opens nothing.
    await vanishes(app, REFUSAL);
    const body = await nodeBox(app, 'mixed');
    await drag(app, from, { x: body.x + body.width / 2, y: body.y + body.height - 30 });
    await appears(app, REFUSAL);
    assert.equal(await text(app, REFUSAL), 'Combine (Reference) has no free input for this wire');
    assert.equal(await app.eval<boolean>(`shellTest.exists(${quote(PALETTE)})`), false);
    assert.deepEqual(await wires(app), ALL_WIRES);
    // A legal one replaces the wire that was in the input.
    await drag(app, await port(app, 'fbm', 'out', 'out'), await port(app, 'steep', 'in', 'in'));
    assert.deepEqual(await wires(app), [...ALL_WIRES.filter((wire) => wire !== 'talus.out>steep.in'), 'fbm.out>steep.in'].sort());
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);

    // ---- wires cut by a stroke: Y and the primary button ----
    const [talus, mixed] = [await nodeBox(app, 'talus'), await nodeBox(app, 'mixed')];
    const gap = (talus.x + talus.width + mixed.x) / 2;
    await app.eval(`void graphTest.keyDown('KeyY', 'y')`);
    assert.equal(await attr(app, '[data-graph="root"]', 'data-cutting'), '');
    await drag(app, { x: gap, y: talus.y - 20 }, { x: gap, y: steep.y + 20 }, {}, 12, false);
    assert.ok((await attr(app, '[data-graph="stroke"]', 'points') ?? '').split(' ').length > 5, 'the stroke is drawn');
    t.diagnostic(`capture: ${await capture(app, 'editing-04-cutting-wires')}`);
    await app.eval(`void graphTest.up(${gap}, ${steep.y + 20})`);
    await app.eval(`void graphTest.keyUp('KeyY', 'y')`);
    assert.equal(await attr(app, '[data-graph="root"]', 'data-cutting'), null);
    assert.deepEqual(await wires(app), ['fbm.out>talus.in', 'steep.out>dist.in'], 'the four wires that cross the gap between the columns are cut');
    assert.deepEqual(await history(app), ['Cut Wires'], 'in one step');
    assert.deepEqual(await selection(app), [], 'a stroke selects nothing and drags nothing');
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
    // The same with Control and the secondary button, which then opens no menu.
    const cut = await wireAt(app, 'steep-out-dist-in');
    await app.eval(`void (graphTest.down(${cut.x}, ${cut.y - 30}, { button: 2, ctrlKey: true }), graphTest.move(${cut.x}, ${cut.y}, { button: 2, ctrlKey: true }),
      graphTest.move(${cut.x}, ${cut.y + 30}, { button: 2, ctrlKey: true }), graphTest.up(${cut.x}, ${cut.y + 30}, { button: 2, ctrlKey: true }),
      document.elementFromPoint(${cut.x}, ${cut.y + 30}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${cut.x}, clientY: ${cut.y + 30} })))`);
    assert.deepEqual(await wires(app), ALL_WIRES.filter((wire) => wire !== 'steep.out>dist.in'));
    assert.equal((await history(app)).at(-1), 'Cut Wire');
    await sleep(200);
    assert.equal(await app.eval<boolean>(`shellTest.exists('[data-ui="menu"]')`), false, 'no menu after a stroke');
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
    await redo(app);
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
  });
});

test('editing: groups, navigation, the library, a node dropped on a wire, and the commands by their keys', async (t) => {
  await withApp({ open: GRAPH }, async (app) => {
    await open(app);

    // ---- Mod+G: a group around the selection, named at once ----
    await click(app, await titleOf(app, 'talus'));
    await app.eval(`void graphTest.keyDown('ShiftLeft', 'Shift', { shiftKey: true })`);
    await click(app, await titleOf(app, 'mixed'), { shiftKey: true });
    await app.eval(`void graphTest.keyUp('ShiftLeft', 'Shift')`);
    assert.deepEqual(await selection(app), ['talus', 'mixed']);
    await key(app, 'KeyG', { ctrl: true });
    const [group] = Object.keys((await docOf(app)).groups);
    assert.ok(group, 'a group was made');
    const naming = `[data-group="${group}"] [data-graph="rename"]`;
    await appears(app, naming);
    await app.eval(`void shellTest.type(${quote(naming)}, 'Erosion')`);
    await key(app, 'Enter', {}, naming);
    await vanishes(app, naming);
    let doc = await docOf(app);
    assert.equal(doc.groups[group]!.title, 'Erosion');
    assert.deepEqual(await history(app), ['Group', 'Rename Group']);
    const frame = await app.eval<{ x: number; y: number; width: number; height: number }>(`graphTest.groupBox(${quote(group)})`);
    for (const id of ['talus', 'mixed']) {
      const box = await nodeBox(app, id);
      assert.ok(box.x > frame.x && box.y > frame.y && box.x + box.width < frame.x + frame.width && box.y + box.height < frame.y + frame.height, `${id} lies inside the frame`);
    }
    // F2 renames the selected group, as it renames a node.
    await key(app, 'F2');
    await appears(app, naming);
    await key(app, 'Escape', {}, naming);
    await vanishes(app, naming);

    // ---- its colour, from its context menu ----
    await secondary(app, await app.eval<Point>(`graphTest.group(${quote(group)})`));
    await appears(app, '[data-ui="menu"] [data-item="color"]');
    await app.eval(`void shellTest.hover('[data-ui="menu"] [data-item="color"]')`);
    await appears(app, '[data-ui="menu"] [data-item="color-adjust"]');
    t.diagnostic(`capture: ${await capture(app, 'editing-05-group-menu')}`);
    await app.eval(`void shellTest.press('[data-ui="menu"] [data-item="color-adjust"]')`);
    await vanishes(app, '[data-ui="menu"]');
    assert.equal((await docOf(app)).groups[group]!.color, '#246283', 'the colour is one of the theme\'s, read from it');

    // ---- dragged by its title bar, it takes what it holds along, as one step ----
    doc = await docOf(app);
    const zoom = (await drawn(app)).zoom;
    const grip = await app.eval<Point>(`graphTest.group(${quote(group)})`);
    const steps = (await history(app)).length;
    // Down and right, away from the panel's edge: near it the library pans the graph along with the drag.
    await drag(app, grip, { x: grip.x + 60, y: grip.y + 30 }, {}, 10, false);
    // While it is dragged the nodes follow on the screen and the document holds still (8.5 rule 8).
    assert.deepEqual((await docOf(app)).nodes.talus!.position, doc.nodes.talus!.position);
    assert.ok((await nodeBox(app, 'talus')).x > (await nodeBox(app, 'fbm')).x + 224 + 56 * zoom + 30, 'the node moves with the frame');
    await app.eval(`void graphTest.up(${grip.x + 60}, ${grip.y + 30})`);
    const moved = await docOf(app);
    for (const id of ['talus', 'mixed']) {
      near(moved.nodes[id]!.position.x - doc.nodes[id]!.position.x, 60 / zoom, 5, `${id} moved with the group, x`);
      near(moved.nodes[id]!.position.y - doc.nodes[id]!.position.y, 30 / zoom, 5, `${id} moved with the group, y`);
    }
    assert.equal(moved.nodes.talus!.position.x - doc.nodes.talus!.position.x, moved.groups[group]!.rect.x - doc.groups[group]!.rect.x, 'by exactly as much as the frame');
    assert.deepEqual(moved.nodes.steep!.position, doc.nodes.steep!.position, 'a node outside stays');
    assert.deepEqual((await history(app)).slice(steps), ['Move']);
    t.diagnostic(`capture: ${await capture(app, 'editing-06-group')}`);
    await undo(app);
    assert.deepEqual([(await docOf(app)).nodes.talus!.position, (await docOf(app)).groups[group]!.rect], [doc.nodes.talus!.position, doc.groups[group]!.rect]);

    // ---- resized by its corner; deleted, it leaves its nodes ----
    const corner = await app.eval<Point>(`graphTest.centre(${quote(`[data-group="${group}"] [data-group-resize]`)})`);
    await app.eval(`void (graphTest.down(${corner.x}, ${corner.y}), graphTest.move(${corner.x + 40}, ${corner.y + 30}), graphTest.up(${corner.x + 40}, ${corner.y + 30}))`);
    near((await docOf(app)).groups[group]!.rect.w - doc.groups[group]!.rect.w, 40 / zoom, 2, 'wider by the drag');
    assert.equal((await history(app)).at(-1), 'Resize Group');
    // A box drawn inside the frame selects the nodes it touches and not the group: only its title bar selects it.
    await click(app, await emptySpot(app));
    assert.equal(await attr(app, `[data-group="${group}"]`, 'data-selected'), null);
    const inside = await nodeBox(app, 'talus');
    await drag(app, { x: inside.x - 12, y: inside.y + inside.height + 8 }, { x: inside.x + 60, y: inside.y + 40 });
    assert.deepEqual(await selection(app), ['talus']);
    assert.equal(await attr(app, `[data-group="${group}"]`, 'data-selected'), null);
    await click(app, await app.eval<Point>(`graphTest.group(${quote(group)})`));
    assert.equal(await attr(app, `[data-group="${group}"]`, 'data-selected'), '');
    assert.deepEqual(await selection(app), [], 'the group is selected in place of the node');
    await key(app, 'Delete');
    assert.deepEqual([Object.keys((await docOf(app)).groups), Object.keys((await docOf(app)).nodes).length], [[], 5]);
    assert.equal((await history(app)).at(-1), 'Delete Group');

    // ---- zoom with the wheel: what is too small to read is not drawn ----
    const box = await graphBox(app);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const fitted = await drawn(app);
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'near');
    /** Turns the wheel a notch at a time until the graph is at the level of detail asked for. */
    const zoomOutTo = async (lod: string): Promise<void> => {
      for (let tick = 0; tick < 12 && (await app.eval<string>(`graphTest.lod()`)) !== lod; tick++) await app.eval(`void graphTest.wheel(${centre.x}, ${centre.y}, 120)`);
      assert.equal(await app.eval<string>(`graphTest.lod()`), lod);
    };
    await zoomOutTo('mid');
    const mid = await drawn(app);
    assert.ok(mid.zoom < 0.55 && mid.zoom >= 0.3, `zoomed out: ${mid.zoom}`);
    assert.equal(await app.eval<string>(`getComputedStyle(document.querySelector('[data-node="talus"] [data-port] span')).display`), 'none', 'the labels of the ports are not drawn');
    assert.equal(await app.eval<string>(`getComputedStyle(document.querySelector('[data-node="talus"] canvas')).display`), 'block', 'the thumbnails still are');
    t.diagnostic(`capture: ${await capture(app, 'editing-07-zoomed-out')}`);
    await zoomOutTo('far');
    assert.equal(await app.eval<string>(`getComputedStyle(document.querySelector('[data-node="talus"] canvas')).display`), 'none', 'far out, neither are the thumbnails');
    assert.match(await text(app, '[data-graph="toolbar"] [data-role="zoom"]') ?? '', /^\d+%$/);
    await app.waitFor(`Math.abs(graphTest.viewport().zoom - graphTest.drawn().zoom) < 0.001`, PAGE_BACKSTOP_MS);
    // Home fits the graph again.
    await key(app, 'Home');
    await app.waitFor(`graphTest.lod() === 'near'`, PAGE_BACKSTOP_MS);
    near((await drawn(app)).zoom, fitted.zoom, 0.01, 'fitted as before');

    // ---- pan: Space and the primary button ----
    const before = await drawn(app);
    const empty = await emptySpot(app);
    await app.eval(`void graphTest.keyDown('Space', ' ')`);
    assert.equal(await attr(app, '[data-graph="root"]', 'data-panning'), '', 'the pointer shows that a drag will pan');
    await drag(app, empty, { x: empty.x + 80, y: empty.y + 40 });
    await app.eval(`void graphTest.keyUp('Space', ' ')`);
    assert.equal(await attr(app, '[data-graph="root"]', 'data-panning'), null);
    const panned = await drawn(app);
    near(panned.x - before.x, 80, 4, 'panned along x');
    near(panned.y - before.y, 40, 4, 'panned along y');
    assert.deepEqual(await selection(app), [], 'panning draws no selection box');
    await app.waitFor(`Math.abs(graphTest.viewport().x - graphTest.drawn().x) < 0.01`, PAGE_BACKSTOP_MS);
    // Mod+0 fits as Home does; so does the Graph menu, which lists the panel's commands with their keys.
    await key(app, 'Digit0', { ctrl: true });
    await app.waitFor(`Math.abs(graphTest.drawn().x - ${before.x}) < 1 && Math.abs(graphTest.drawn().y - ${before.y}) < 1`, PAGE_BACKSTOP_MS);
    const menu = await openMenu(app, 'Graph');
    assert.deepEqual(menu.map((item) => item.id).filter((id) => id !== null), [
      'graph.addNode', 'graph.insertNode', 'graph.duplicate', 'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', 'graph.group', 'graph.selectContents',
      'graph.useAsTerrain', 'graph.toggleViewLock', 'graph.fit', 'graph.toggleMinimap',
    ]);
    assert.deepEqual(menu.filter((item) => ['graph.addNode', 'graph.fit', 'graph.toggleMinimap'].includes(item.id ?? '')).map((item) => item.key), ['Tab', 'Ctrl+0', 'M']);
    // The whole graph is in view: there is no minimap to hide. Zoomed in, part of the graph lies outside the
    // panel, and the minimap says where; the menu and M put it away and bring it back.
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__minimap') === null`), true);
    await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="menu"]'))`);
    await vanishes(app, '[data-ui="menu"]');
    for (let tick = 0; tick < 4; tick++) await app.eval(`void graphTest.wheel(${centre.x}, ${centre.y}, -120)`);
    await appears(app, '.react-flow__minimap');
    await openMenu(app, 'Graph');
    await app.eval(`void shellTest.press('[data-ui="menu"][data-menu="Graph"] [data-item="graph.toggleMinimap"]')`);
    await vanishes(app, '.react-flow__minimap');
    await focusGraph(app);
    await key(app, 'KeyM');
    await appears(app, '.react-flow__minimap');
    await key(app, 'Home');
    await vanishes(app, '.react-flow__minimap');

    // ---- the view: G makes a mask the terrain, F locks the view to a node ----
    await click(app, await titleOf(app, 'steep'));
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.view?.overlay?.ref.node === 'steep'`, PAGE_BACKSTOP_MS);
    await key(app, 'KeyG');
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'steep', port: 'out' } });
    await key(app, 'KeyF');
    assert.equal((await docOf(app)).ui.view!.locked, true);
    assert.equal(await attr(app, nodeSelector('steep'), 'data-locked'), '');
    assert.equal(await app.eval<string>(`document.querySelector('[data-graph="toolbar"] [data-command="graph.toggleViewLock"]').getAttribute('aria-pressed')`), 'true');
    await click(app, await titleOf(app, 'fbm'));
    assert.deepEqual(await selection(app), ['fbm']);
    await sleep(100);
    assert.deepEqual((await docOf(app)).ui.view!.height, { node: 'steep', port: 'out' }, 'locked: selecting another node does not move the view');
    await key(app, 'KeyF');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.view?.height?.node === 'fbm' && orogenTest.ctx.doc.getState().doc.ui.view.locked === undefined`, PAGE_BACKSTOP_MS);

    // ---- H collapses a node to its header and ports ----
    const tall = (await nodeBox(app, 'fbm')).height;
    await key(app, 'KeyH');
    assert.equal((await docOf(app)).nodes.fbm!.collapsed, true);
    await app.waitFor(`graphTest.node('fbm').height < ${tall - 40}`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-node="fbm"] canvas') === null`), true);
    await key(app, 'KeyH');
    await app.waitFor(`Math.abs(graphTest.node('fbm').height - ${tall}) < 1`, PAGE_BACKSTOP_MS);

    // ---- from the library: a drop on the canvas, the event of a double click, and a drop on a wire (8.7) ----
    const start = await docOf(app);
    const spot = await emptySpot(app);
    assert.equal(await app.eval<boolean>(`graphTest.libraryDrop('generate/island', ${spot.x}, ${spot.y})`), true, 'the graph takes the drag');
    const [island] = await added(app, start);
    assert.ok(island);
    assert.equal((await docOf(app)).nodes[island]!.type, 'generate/island');
    assert.deepEqual(await selection(app), [island]);
    const dropped = await nodeBox(app, island);
    near(dropped.x + dropped.width / 2, spot.x, 2, 'the node lies where it was dropped');
    assert.equal((await history(app)).at(-1), 'Add Island');
    await undo(app);

    // "Add this node now" with nothing selected: not wired, in view, at the place nearest the middle of what the
    // graph shows where it covers no other node (8.7 rule 8).
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);
    await app.eval(`void window.dispatchEvent(new CustomEvent('orogen:add-node', { detail: { type: 'ref/blur' } }))`);
    const [blur] = await added(app, start);
    assert.ok(blur);
    assert.deepEqual(await selection(app), [blur]);
    assert.deepEqual(await wires(app), ALL_WIRES, 'nothing was selected to continue from: no wire was made');
    const placed = await nodeBox(app, blur);
    const pane = await graphBox(app);
    assert.ok(placed.x >= pane.x && placed.x + placed.width <= pane.x + pane.width && placed.y >= pane.y && placed.y + placed.height <= pane.y + pane.height, `in view: ${JSON.stringify(placed)}`);
    for (const other of Object.keys((await docOf(app)).nodes).filter((id) => id !== blur)) {
      const box = await nodeBox(app, other);
      assert.ok(placed.x >= box.x + box.width || box.x >= placed.x + placed.width || placed.y >= box.y + box.height || box.y >= placed.y + placed.height, `the new node does not cover ${other}`);
    }

    // ---- that node dragged onto a wire goes into it: the wire is marked, and the drop is one step ----
    const wire = await wireAt(app, 'steep-out-dist-in');
    const title = await titleOf(app, blur);
    const target = { x: title.x + (wire.x - (placed.x + placed.width / 2)), y: title.y + (wire.y - (placed.y + placed.height / 2)) };
    const count = (await history(app)).length;
    await drag(app, title, target, {}, 12, false);
    assert.equal(await app.eval<string | null>(`document.querySelector('.react-flow__edge path[data-drop]')?.closest('.react-flow__edge').getAttribute('data-id') ?? null`), 'e-steep-out-dist-in', 'the wire under the node is marked');
    assert.equal(await attr(app, '[data-graph="root"]', 'data-inserting'), '', 'and so is the node, which may hide the wire');
    t.diagnostic(`capture: ${await capture(app, 'editing-08-node-over-a-wire')}`);
    await app.eval(`void graphTest.up(${target.x}, ${target.y})`);
    assert.deepEqual(await wires(app), [...ALL_WIRES.filter((entry) => entry !== 'steep.out>dist.in'), `steep.out>${blur}.in`, `${blur}.out>dist.in`].sort());
    assert.deepEqual((await history(app)).slice(count), ['Insert Blur (Reference)']);
    assert.equal(await app.eval<boolean>(`document.querySelector('.react-flow__edge path[data-drop]') === null`), true);
    assert.equal(await attr(app, '[data-graph="root"]', 'data-inserting'), null);
    await undo(app);
    assert.deepEqual(await wires(app), ALL_WIRES);
    near((await nodeBox(app, blur)).x, placed.x, 1, 'one step back: out of the wire and back where it was');
    await redo(app);
    assert.equal((await wires(app)).includes(`${blur}.out>dist.in`), true);

    // A node from the library dropped on a wire goes into it as well.
    const again = await wireAt(app, 'fbm-out-talus-in');
    const held = await docOf(app);
    await app.eval(`void graphTest.libraryDrop('surface/terraces', ${again.x}, ${again.y})`);
    const [terraces] = await added(app, held);
    assert.ok(terraces);
    assert.ok((await wires(app)).includes(`fbm.out>${terraces}.in`) && (await wires(app)).includes(`${terraces}.out>talus.in`));
    assert.equal((await history(app)).at(-1), 'Add Terraces');
    await settled(app);

    // ---- a project that brings a viewport of the graph is shown with it (4.1: ui.graphViewport) ----
    const brought = { x: 123, y: -45, zoom: 0.8 };
    await app.eval(`void (() => {
      const state = orogenTest.ctx.doc.getState();
      const doc = JSON.parse(JSON.stringify(state.doc));
      doc.ui.graphViewport = ${quote(brought)};
      state.load(doc, null);
    })()`);
    await app.waitFor(`Math.abs(graphTest.drawn().x - 123) < 0.01 && Math.abs(graphTest.drawn().y + 45) < 0.01 && Math.abs(graphTest.drawn().zoom - 0.8) < 0.0001`, PAGE_BACKSTOP_MS);
    await sleep(500);
    assert.deepEqual((await docOf(app)).ui.graphViewport, brought, 'and the graph does not fit it away');
    assert.deepEqual([await selection(app), await history(app)], [[], []]);
  });
});
