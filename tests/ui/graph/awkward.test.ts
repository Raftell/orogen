// The graph where it is awkward: drags that are interrupted by Escape and by an undo, a wire pulled off its
// input and put elsewhere, a wire let go over a node, the palette in a window too small for the panel to hold
// it, every node type of the product with its labels, and thumbnails after their canvases were emptied.
//
// The captures are written for a person (testing.md 8.5 rule 1): graph/awkward-01 … awkward-07.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { addNode, createRegistry, newDoc, serializeDoc, setSettings, type DocDraft } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  added, appears, attr, capture, click, docked, docOf, drag, focusGraph, graphBox, graphSettled, history, key, near, nodeBox, nodeSelector, OUTPUT, PAGE_BACKSTOP_MS,
  port, quote, ready, redo, selection, settled, sleep, text, titleOf, undo, vanishes, wires, withApp,
  type Point,
} from './rig.ts';

const REGISTRY = createRegistry(nodes);
const PALETTE = '[data-graph="palette"]';
const REFUSAL = '[data-graph="refusal"]';

/** Adds a node from the palette with its middle at a point of the window, and returns its id. */
async function addByPalette(app: AppDriver, at: Point, query: string, type: string): Promise<string> {
  const before = await docOf(app);
  await app.eval(`void graphTest.hover(${at.x}, ${at.y})`);
  await key(app, 'Tab');
  await appears(app, PALETTE);
  await app.eval(`void shellTest.type(${quote(`${PALETTE} input`)}, ${quote(query)})`);
  await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === ${quote(type)}`, PAGE_BACKSTOP_MS);
  await key(app, 'Enter', {}, `${PALETTE} input`);
  await vanishes(app, PALETTE);
  const [id] = await added(app, before);
  assert.ok(id, `${type} was added`);
  return id;
}

const connecting = (app: AppDriver): Promise<boolean> => app.eval<boolean>(`document.querySelector('.react-flow__connection') !== null`);
const dragPositions = (app: AppDriver): Promise<unknown> => app.eval(`orogenTest.ctx.ui.getState().dragPositions`);

test('awkward: a wire onto a node and off its input, and drags ended by Escape and by an undo', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    await graphSettled(app);
    await focusGraph(app);
    const range = Object.keys((await docOf(app)).nodes)[0]!;
    const rangeBox = await nodeBox(app, range);
    const blur = await addByPalette(app, { x: rangeBox.x + rangeBox.width + 180, y: rangeBox.y - 20 }, 'blur', 'filter/blur');
    const terraces = await addByPalette(app, { x: rangeBox.x + rangeBox.width + 180, y: rangeBox.y + 170 }, 'terr', 'surface/terraces');

    // ---- a wire let go over a node, off its ports, goes to the node's first free input ----
    const out = await port(app, range, 'out', 'out');
    const body = await nodeBox(app, blur);
    await drag(app, out, { x: body.x + body.width / 2, y: body.y + body.height - 12 });
    assert.deepEqual(await wires(app), [`${range}.out>${blur}.in`]);
    assert.equal((await history(app)).at(-1), 'Connect');
    assert.equal(await app.eval<boolean>(`shellTest.exists(${quote(PALETTE)})`), false, 'no palette: the wire found its node');
    // A second wire onto the same node: its terrain input is taken and its mask input is for masks, so nothing is connected and the graph says why.
    await drag(app, out, { x: body.x + body.width / 2, y: body.y + body.height - 12 });
    await appears(app, REFUSAL);
    assert.equal(await text(app, REFUSAL), 'Blur has no free input for this wire');
    assert.deepEqual(await wires(app), [`${range}.out>${blur}.in`]);

    // ---- the end of a wire is taken off its input and put into another: one step ----
    const [from, to] = [await port(app, blur, 'in', 'in'), await port(app, terraces, 'in', 'in')];
    const steps = (await history(app)).length;
    await drag(app, from, to, {}, 8, false);
    assert.equal(await connecting(app), true, 'the wire follows the pointer');
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge[data-moving]').length`), 1, 'and where it was is marked as what will go');
    t.diagnostic(`capture: ${await capture(app, 'awkward-01-wire-moved-to-another-input')}`);
    await app.eval(`void graphTest.up(${to.x}, ${to.y})`);
    assert.deepEqual(await wires(app), [`${range}.out>${terraces}.in`]);
    assert.deepEqual((await history(app)).slice(steps), ['Reconnect']);
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge[data-moving]').length`), 0);
    await undo(app);
    assert.deepEqual(await wires(app), [`${range}.out>${blur}.in`]);
    // Put back into the input it came from: nothing happened.
    await drag(app, from, { x: from.x + 60, y: from.y + 40 }, {}, 6, false);
    await app.eval(`void (graphTest.move(${from.x}, ${from.y}), graphTest.up(${from.x}, ${from.y}))`);
    assert.deepEqual([await wires(app), (await history(app)).length], [[`${range}.out>${blur}.in`], steps]);
    // Pulled off and let go on the empty canvas: the wire goes, and no palette opens for it.
    const pane = await graphBox(app);
    await drag(app, from, { x: pane.x + 140, y: pane.y + pane.height - 60 });
    assert.deepEqual(await wires(app), []);
    assert.equal((await history(app)).at(-1), 'Disconnect');
    await sleep(100);
    assert.equal(await app.eval<boolean>(`shellTest.exists(${quote(PALETTE)})`), false);
    await undo(app);
    assert.deepEqual(await wires(app), [`${range}.out>${blur}.in`]);
    // A press on that input without a drag changes nothing and leaves nothing marked.
    await click(app, from);
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge[data-moving]').length`), 0);
    assert.deepEqual(await wires(app), [`${range}.out>${blur}.in`]);

    // ---- Escape calls a dragged wire off: its release then connects nothing and opens nothing ----
    const count = (await history(app)).length;
    const blurOut = await port(app, blur, 'out', 'out');
    await drag(app, blurOut, to, {}, 8, false);
    assert.equal(await connecting(app), true);
    await key(app, 'Escape');
    assert.equal(await connecting(app), false, 'the wire is gone with the key');
    await app.eval(`void graphTest.up(${to.x}, ${to.y})`);
    await sleep(100);
    assert.deepEqual([await wires(app), (await history(app)).length, await app.eval<boolean>(`shellTest.exists(${quote(PALETTE)})`)], [[`${range}.out>${blur}.in`], count, false]);

    // ---- Escape calls a dragged node off: it is back where it was, and the history has no step ----
    const before = await nodeBox(app, terraces);
    const grip = await titleOf(app, terraces);
    await drag(app, grip, { x: grip.x + 70, y: grip.y + 40 }, {}, 8, false);
    near((await nodeBox(app, terraces)).x, before.x + 70, 4, 'the node follows the pointer');
    await key(app, 'Escape');
    assert.equal(await dragPositions(app), null);
    near((await nodeBox(app, terraces)).x, before.x, 0.5, 'back where it was');
    await app.eval(`void (graphTest.move(${grip.x + 90}, ${grip.y + 50}), graphTest.up(${grip.x + 90}, ${grip.y + 50}))`);
    near((await nodeBox(app, terraces)).x, before.x, 0.5, 'and the release moves nothing');
    assert.equal((await history(app)).length, count);
    // The button is let go over the canvas: the click that makes belongs to the drag that was called off, and
    // does not clear the selection as a click on the canvas does.
    assert.deepEqual(await selection(app), [terraces]);
    const bare = { x: pane.x + 150, y: pane.y + pane.height - 50 };
    await drag(app, grip, bare, {}, 8, false);
    await key(app, 'Escape');
    await app.eval(`void graphTest.up(${bare.x}, ${bare.y}, {}, true)`);
    assert.deepEqual(await selection(app), [terraces]);
    await click(app, bare);
    assert.deepEqual(await selection(app), [], 'the next click is a click again');

    // ---- an undo in the middle of a drag takes the dragged node away: nothing of the drag is left behind ----
    const fresh = await addByPalette(app, { x: rangeBox.x - 150, y: rangeBox.y + 190 }, 'slope', 'select/slope');
    const placed = await nodeBox(app, fresh);
    const hold = await titleOf(app, fresh);
    await drag(app, hold, { x: hold.x + 60, y: hold.y - 30 }, {}, 6, false);
    assert.notEqual(await dragPositions(app), null);
    await undo(app);
    assert.equal(Object.hasOwn((await docOf(app)).nodes, fresh), false, 'the node was added by the step that was undone');
    assert.equal(await dragPositions(app), null, 'where the drag showed it is forgotten with it');
    await app.eval(`void (graphTest.move(${hold.x + 80}, ${hold.y - 40}), graphTest.up(${hold.x + 80}, ${hold.y - 40}))`);
    assert.equal(await dragPositions(app), null);
    await redo(app);
    await appears(app, nodeSelector(fresh));
    near((await nodeBox(app, fresh)).x, placed.x, 0.5, 'brought back, it is drawn where the document has it');
    near((await nodeBox(app, fresh)).y, placed.y, 0.5, 'brought back, it is drawn where the document has it');
    // And it is dragged like any other node afterwards: one step.
    const again = await titleOf(app, fresh);
    await drag(app, again, { x: again.x - 40, y: again.y + 20 });
    assert.equal((await history(app)).at(-1), 'Move');
    assert.equal(await dragPositions(app), null);
    // A redo in the middle of a drag: the same.
    await undo(app);
    await drag(app, again, { x: again.x - 30, y: again.y + 10 }, {}, 6, false);
    await redo(app);
    assert.equal(await dragPositions(app), null);
    await app.eval(`void graphTest.up(${again.x - 30}, ${again.y + 10})`);
    assert.equal(await dragPositions(app), null);

    // ---- a wire dropped on the canvas: it stays drawn to where it was let go while the palette is open beside that point ----
    const slopeOut = await port(app, fresh, 'out', 'out');
    const drop = { x: slopeOut.x + 90, y: slopeOut.y + 40 };
    await drag(app, slopeOut, drop);
    await appears(app, PALETTE);
    const pending = await attr(app, '[data-graph="pending-wire"]', 'd');
    assert.match(pending ?? '', /^M[-0-9.]+,[-0-9.]+ C/, 'the wire is drawn');
    const palette = await app.eval<{ x: number; y: number; width: number; height: number }>(`graphTest.box(${quote(PALETTE)})`);
    near(palette.x, drop.x, 1, 'the palette lies right of where the wire ends, not over the node it comes from');
    assert.ok(palette.y >= 8 && palette.y + palette.height <= (await app.eval<number>(`innerHeight`)) - 7, 'and inside the window, though the panel ends above its lower edge');
    assert.ok(palette.y + palette.height > pane.y + pane.height, 'it is not held inside the panel');
    assert.equal(await attr(app, '[data-graph="pending-wire"]', 'data-tone'), 'mask');
    t.diagnostic(`capture: ${await capture(app, 'awkward-02-palette-beside-the-dropped-wire')}`);
    // A turn of the wheel moves the graph under it: the palette, which lies where the graph was, closes.
    await app.eval(`void graphTest.wheel(${pane.x + 60}, ${pane.y + 60}, 40)`);
    await vanishes(app, PALETTE);
    assert.equal(await app.eval<boolean>(`shellTest.exists('[data-graph="pending-wire"]')`), false);
    assert.equal(await app.eval<string>(`document.activeElement?.getAttribute('data-panel') ?? ''`), 'graph', 'the keys are the graph\'s again');
    assert.deepEqual(await selection(app), [fresh]);

    // ---- from the Library panel as it is: a row of it dragged out and dropped on the graph, and a double click on one (8.7) ----
    await app.eval(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === 'Library'))`);
    await appears(app, '[data-panel="library"] [role="option"][data-node]');
    const held = await docOf(app);
    const spot = { x: pane.x + 160, y: pane.y + 110 };
    assert.equal(await app.eval<boolean>(`document.elementFromPoint(${spot.x}, ${spot.y}).classList.contains('react-flow__pane')`), true, 'a bare place of the canvas');
    const dragged = await app.eval<{ type: string; taken: boolean; types: string[] }>(`(() => {
      const row = document.querySelector('[data-panel="library"] [role="option"][data-node]');
      const data = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, dataTransfer: data }));
      const target = document.elementFromPoint(${spot.x}, ${spot.y});
      const init = { bubbles: true, cancelable: true, composed: true, clientX: ${spot.x}, clientY: ${spot.y}, dataTransfer: data };
      const over = new DragEvent('dragover', init);
      target.dispatchEvent(over);
      target.dispatchEvent(new DragEvent('drop', init));
      return { type: row.getAttribute('data-node'), taken: over.defaultPrevented, types: [...data.types] };
    })()`);
    assert.deepEqual([dragged.taken, dragged.types.includes('application/x-orogen-node')], [true, true], 'the library\'s drag is one the graph takes');
    const [dropped] = await added(app, held);
    assert.ok(dropped, 'the node was added');
    assert.equal((await docOf(app)).nodes[dropped]!.type, dragged.type);
    assert.deepEqual(await selection(app), [dropped]);
    const landed = await nodeBox(app, dropped);
    near(landed.x + landed.width / 2, spot.x, 2, 'its middle is where it was dropped, x');
    near(landed.y + landed.height / 2, spot.y, 2, 'its middle is where it was dropped, y');
    const more = await docOf(app);
    const asked = await app.eval<string>(`(() => {
      const row = [...document.querySelectorAll('[data-panel="library"] [role="option"][data-node]')].at(1);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window }));
      return row.getAttribute('data-node');
    })()`);
    const [second] = await added(app, more);
    assert.ok(second, 'a double click in the library adds its node');
    assert.equal((await docOf(app)).nodes[second]!.type, asked);
    assert.deepEqual(await selection(app), [second]);
    const centred = await nodeBox(app, second);
    near(centred.x + centred.width / 2, pane.x + pane.width / 2, 2, 'at the centre of what the graph shows');
    assert.deepEqual((await history(app)).slice(-2).map((label) => label.slice(0, 4)), ['Add ', 'Add ']);
    t.diagnostic(`capture: ${await capture(app, 'awkward-02b-nodes-from-the-library')}`);
  });
});

/** Every node type of the product, in rows of twelve. */
function everyType(): string {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { buildResolution: 1009, previewLevel: 2 });
  REGISTRY.list().forEach((def, index) => addNode(draft, REGISTRY, def.type, { x: (index % 12) * 340, y: Math.floor(index / 12) * 200 }));
  return serializeDoc(draft);
}

test('awkward: every node type is drawn with the whole of every port label and of its title, at the size the graph computes', async (t) => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const file = path.join(OUTPUT, 'every-type.orogen');
  fs.writeFileSync(file, everyType());
  await withApp({ open: file }, async (app) => {
    await ready(app);
    await docked(app);
    await graphSettled(app);
    await focusGraph(app);
    const count = REGISTRY.list().length;
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-node]').length`), count);
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'far');
    t.diagnostic(`capture: ${await capture(app, 'awkward-03-every-type-fitted')}`);

    // Close up on the simulations, whose ports have the longest labels: labels are drawn at this zoom, and every
    // node is laid out whether the panel shows it or not.
    const rivers = await app.eval<string>(`[...document.querySelectorAll('[data-node]')].find((node) => node.getAttribute('data-type') === 'simulate/rivers').getAttribute('data-node')`);
    const box = await nodeBox(app, rivers);
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    for (let tick = 0; tick < 30 && (await app.eval<number>(`graphTest.drawn().zoom`)) < 1; tick++) await app.eval(`void graphTest.wheel(${at.x}, ${at.y}, -100)`);
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'near');
    const drawn = await app.eval<{ type: string; cut: string[]; title: boolean; width: number; told: number; height: number; toldHeight: number; widest: number; spills: boolean; ports: number }[]>(`[...document.querySelectorAll('[data-node]')].map((node) => {
      const labels = [...node.querySelectorAll('[data-port] span')];
      const title = node.querySelector('[data-role="title"]');
      const wrapper = node.parentElement;
      // How far the dot of a port lies from the middle of the row its label is in, at the worst.
      const ports = Math.max(0, ...[...node.querySelectorAll('.react-flow__handle')].map((handle) => {
        const row = node.querySelector('[data-side="' + handle.getAttribute('data-side') + '"] > [data-port="' + CSS.escape(handle.getAttribute('data-port')) + '"]');
        const [a, b] = [handle.getBoundingClientRect(), row.getBoundingClientRect()];
        return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
      }));
      return {
        type: node.getAttribute('data-type'), cut: labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
        title: title.scrollWidth > title.clientWidth, width: wrapper.offsetWidth, told: parseFloat(wrapper.style.width), height: wrapper.offsetHeight, toldHeight: parseFloat(wrapper.style.height),
        widest: Math.max(0, ...labels.map((label) => label.scrollWidth)), spills: node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth, ports,
      };
    })`);
    // A label that is cut reads as another: 'Water surface' and 'Water depth' were both 'Water …'.
    const cut = drawn.filter((node) => node.cut.length > 0).map((node) => `${node.type}: ${node.cut.join(', ')}`);
    assert.deepEqual(cut, [], 'no port label is cut');
    assert.deepEqual(drawn.filter((node) => node.title).map((node) => node.type), [], 'no title of a type is cut');
    // The size is computed from the ports alone (geometry.ts) and handed to the library, which measures nothing:
    // what the style sheet lays out must fit it, and every dot must lie in the row of its label.
    assert.deepEqual(drawn.filter((node) => node.width !== node.told || node.height !== node.toldHeight).map((node) => node.type), [], 'the size drawn is the size computed');
    assert.deepEqual(drawn.filter((node) => node.spills).map((node) => node.type), [], 'nothing of a node lies outside the size computed for it');
    assert.deepEqual(drawn.filter((node) => node.ports > 1.5).map((node) => `${node.type}: ${node.ports}`), [], 'the dot of every port lies in the row of its label');
    const widths = [...new Set(drawn.map((node) => node.width))].sort((a, b) => a - b);
    t.diagnostic(`${count} types in ${widths.length} widths: ${widths.map((width) => `${width} px × ${drawn.filter((node) => node.width === width).length}`).join(', ')}; the widest label is ${Math.max(...drawn.map((node) => node.widest))} px`);
    assert.equal(widths[0], 224);
    assert.ok(Math.max(...drawn.map((node) => node.widest)) > 60, 'the labels were measured');
    assert.deepEqual(
      await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${nodeSelector(rivers)} [data-side="out"] [data-port] span`)})].map((label) => label.textContent)`),
      ['Out', 'River', 'Water depth', 'Water surface'],
    );
    await appears(app, '.react-flow__minimap');
    t.diagnostic(`capture: ${await capture(app, 'awkward-04-simulations-close-up')}`);
  });
});

test('awkward: in the least window the palette is whole, and thumbnails come back after their canvases were emptied', async (t) => {
  await withApp({ open: 'tests/graphs/03-simulate.orogen' }, async (app) => {
    await ready(app);
    await docked(app);
    await graphSettled(app);
    await focusGraph(app);
    await app.waitFor(`document.querySelectorAll('[data-thumbnail="drawn"]').length === 5`, 60_000);
    /** The share of a thumbnail's pixels that are painted: an emptied canvas has none. */
    const painted = (id: string): Promise<number> => app.eval<number>(`(() => {
      const canvas = document.querySelector(${quote(`${nodeSelector(id)} canvas`)});
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] === 255) count++;
      return count / (data.length / 4);
    })()`);
    assert.equal(await painted('fbm'), 1, 'the thumbnail is drawn into the canvas');

    // ---- a canvas that was emptied, as the loss of the GPU process empties one, is drawn again from the cache ----
    // The engine sends a thumbnail once for a content key (runtime.md 5.12): nothing else would fill it.
    await app.eval(`void (() => {
      const canvas = document.querySelector('[data-node="talus"] canvas');
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    })()`);
    assert.equal(await painted('talus'), 0);
    await app.eval(`void document.querySelector('[data-node="talus"] canvas').dispatchEvent(new Event('contextrestored'))`);
    assert.equal(await painted('talus'), 1);

    // ---- the least window the application has: the graph panel is lower than the palette ----
    await app.eval(`void window.resizeTo(960, 600)`);
    await app.waitFor(`innerWidth <= 960 && innerHeight <= 600`, PAGE_BACKSTOP_MS);
    // The dock lays its panels out again for the new window: the graph ends where the panels beside it begin.
    await app.waitFor(`(() => { const box = graphTest.graph(); return box.y + box.height <= innerHeight + 1 && box.x + box.width <= innerWidth - 150; })()`, PAGE_BACKSTOP_MS);
    await graphSettled(app).catch(() => {});
    const small = await graphBox(app);
    assert.ok(small.height < 360, `the panel is ${small.height} pixels high, the palette 360`);
    // The resize of a window that was never shown costs the engine its device (measured, tests/ui/inspector):
    // the thumbnails are in main memory and stay.
    for (const id of ['fbm', 'talus', 'steep']) assert.equal(await painted(id), 1, `the thumbnail of ${id} after the window was resized`);
    t.diagnostic(`capture: ${await capture(app, 'awkward-05-least-window')}`);
    await focusGraph(app);
    // The pointer near the right edge of the panel, above the shell's notice of the lost device.
    const pointer = { x: small.x + small.width - 60, y: small.y + 70 };
    assert.equal(await app.eval<boolean>(`document.elementFromPoint(${pointer.x}, ${pointer.y})?.closest('[data-graph="root"]') !== null`), true);
    await app.eval(`void graphTest.hover(${pointer.x}, ${pointer.y})`);
    await key(app, 'Tab');
    await appears(app, PALETTE);
    const palette = await app.eval<{ x: number; y: number; width: number; height: number }>(`graphTest.box(${quote(PALETTE)})`);
    const view = await app.eval<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);
    assert.deepEqual([palette.width, palette.height], [480, 360]);
    assert.ok(palette.x >= 8 && palette.y >= 8 && palette.x + palette.width <= view.width - 7 && palette.y + palette.height <= view.height - 7, `the whole palette is in the window: ${JSON.stringify(palette)}`);
    // Near the right edge of the window it lies left of the pointer, not over it; and it is moved up, since the window ends below.
    near(palette.x + palette.width, pointer.x, 1, 'its right edge is at the pointer');
    assert.ok(palette.y < small.y, 'it reaches above the panel');
    // Nothing of it is hidden by the panel's edge: its last line is what a point at its lower edge hits.
    assert.equal(await app.eval<boolean>(`document.elementFromPoint(${palette.x + 40}, ${palette.y + palette.height - 6})?.closest('[data-graph="palette"]') !== null`), true);
    assert.equal(await app.eval<boolean>(`document.elementFromPoint(${palette.x + 40}, ${palette.y + 12})?.closest('[data-graph="palette"]') !== null`), true);
    t.diagnostic(`capture: ${await capture(app, 'awkward-06-least-window-palette')}`);
    const start = await docOf(app);
    await app.eval(`void shellTest.type(${quote(`${PALETTE} input`)}, 'island')`);
    await app.waitFor(`document.querySelector(${quote(`${PALETTE} [aria-selected="true"][data-type]`)})?.getAttribute('data-type') === 'generate/island'`, PAGE_BACKSTOP_MS);
    await key(app, 'Enter', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    const [island] = await added(app, start);
    assert.ok(island, 'the node chosen there is added');
    await key(app, 'Home');
    await vanishes(app, '.react-flow__minimap');
    t.diagnostic(`capture: ${await capture(app, 'awkward-07-least-window-fitted')}`);
  });
});

test('awkward: a narrow panel and a wide one hold the graph, its toolbar and its palette', async (t) => {
  await withApp({ open: 'tests/graphs/03-simulate.orogen' }, async (app) => {
    await ready(app);
    await docked(app);
    await graphSettled(app);
    await focusGraph(app);
    /** Gives the column of the viewport and the graph a width, as a drag of the sash beside it does: the dock's layout with that width, restored. */
    const widen = async (width: number): Promise<void> => {
      const restored = await app.eval<string>(`(() => {
        const saved = JSON.parse(JSON.stringify(orogenTest.shell.layout()));
        const columns = saved.dock.grid.root.data;
        const left = columns.find((column) => column.type === 'branch');
        const right = columns.find((column) => column !== left);
        if (!left || !right) throw new Error('The dock is not in its default layout');
        right.size += left.size - ${width};
        left.size = ${width};
        return orogenTest.shell.dock.restore(saved);
      })()`);
      assert.equal(restored, 'restored');
      await app.waitFor(`document.querySelector('[data-graph="root"] .react-flow__pane') !== null && Math.abs(graphTest.graph().width - ${width}) <= 8`, PAGE_BACKSTOP_MS);
      await graphSettled(app);
      await focusGraph(app);
    };
    /** Whether every node lies wholly inside the panel. */
    const allInside = (): Promise<boolean> => app.eval<boolean>(`(() => {
      const view = document.querySelector('[data-graph="root"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-node]')].every((node) => {
        const r = node.getBoundingClientRect();
        return r.left >= view.left && r.right <= view.right && r.top >= view.top && r.bottom <= view.bottom;
      });
    })()`);

    // ---- narrow: a third of the width the panel has by default ----
    await widen(360);
    const narrow = await graphBox(app);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-node]').length`), 5, 'the graph is there in the panel the dock made anew');
    await key(app, 'Home');
    await app.waitFor(`graphTest.drawn().zoom < 0.5`, PAGE_BACKSTOP_MS);
    assert.equal(await allInside(), true, 'fitted, the five nodes lie inside the narrow panel');
    await vanishes(app, '.react-flow__minimap');
    const bar = await app.eval<{ x: number; y: number; width: number; height: number }>(`graphTest.box('[data-graph="toolbar"]')`);
    assert.ok(bar.x >= narrow.x && bar.x + bar.width <= narrow.x + narrow.width, `the toolbar is inside the panel: ${JSON.stringify(bar)}`);
    await app.eval(`void graphTest.hover(${narrow.x + narrow.width / 2}, ${narrow.y + narrow.height - 40})`);
    await key(app, 'Tab');
    await appears(app, PALETTE);
    const palette = await app.eval<{ x: number; y: number; width: number; height: number }>(`graphTest.box(${quote(PALETTE)})`);
    assert.ok(palette.width > narrow.width && palette.x + palette.width <= (await app.eval<number>(`innerWidth`)) - 7, `the palette is wider than the panel and whole: ${JSON.stringify(palette)}`);
    t.diagnostic(`capture: ${await capture(app, 'awkward-08-narrow-panel')}`);
    await key(app, 'Escape', {}, `${PALETTE} input`);
    await vanishes(app, PALETTE);
    // The pointer and the keys work in the panel the dock made anew, and the graph that was there before it
    // listens no more: a node asked for from outside (8.7) is added once, and text pasted once.
    await app.eval(`void graphTest.wheel(${narrow.x + narrow.width / 2}, ${narrow.y + narrow.height / 2}, -300)`);
    await click(app, await titleOf(app, 'talus'));
    assert.deepEqual(await selection(app), ['talus']);
    await key(app, 'KeyB');
    assert.equal((await docOf(app)).nodes.talus!.bypass, true);
    await undo(app);
    await app.eval(`void window.dispatchEvent(new CustomEvent('orogen:add-node', { detail: { type: 'filter/blur' } }))`);
    assert.equal(Object.keys((await docOf(app)).nodes).length, 6);
    const copied = await app.eval<{ taken: boolean; text: string }>(`graphTest.clipboard('copy')`);
    assert.equal(copied.taken, true);
    await app.eval(`graphTest.clipboard('paste', ${quote(copied.text)})`);
    assert.equal(Object.keys((await docOf(app)).nodes).length, 7);
    assert.deepEqual(await history(app), ['Add Blur', 'Paste']);

    // ---- wide: nearly the whole window ----
    await widen(1440);
    await key(app, 'Home');
    await app.waitFor(`graphTest.drawn().zoom > 0.9`, PAGE_BACKSTOP_MS);
    const zoom = await app.eval<number>(`graphTest.drawn().zoom`);
    assert.ok(zoom <= 1, `a small graph is not blown up to fill a wide panel: ${zoom}`);
    assert.equal(await allInside(), true);
    t.diagnostic(`capture: ${await capture(app, 'awkward-09-wide-panel')}`);
  });
});
