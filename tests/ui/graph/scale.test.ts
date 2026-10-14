// The graph with 300 nodes (ui-stack.md a.8): a generated project of 300 nodes, 3 groups and some 380 wires is
// opened, and panning, zooming, dragging and box selection are driven by synthesised input while the time of
// every step is taken.
//
// What is measured, and what is not. A window that was never shown draws one frame a second (testing.md 8.5),
// so no frame can be timed here. A step is timed from the input event until the page has nothing left to do
// for it: the event's handlers, React's renders and effects (flushed by a turn of the event loop), and a forced
// style and layout of the document. That is the script and layout of a frame; painting and compositing are not
// in it, and neither is a real pointer's event rate. The numbers are reported, in the test's output and in
// <OROGEN_TEST_OUTPUT>/graph-panel/scale-300.json, and nothing is asserted about them: the test asserts that the
// graph did what the input asked for.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { addNode, connect, createRegistry, newDoc, serializeDoc, setGroup, setSettings, type DocDraft, type GraphDoc } from '../../../src/core/runtime.ts';
import {
  capture, docked, docOf, drawn, focusGraph, graphBox, graphSettled, history, key, nodeBox, OUTPUT, PAGE_BACKSTOP_MS, quote, ready, selection, withApp,
  type Point,
} from './rig.ts';

const REGISTRY = createRegistry(nodes);
const COLUMNS = 20;
const ROWS = 15;
const FILE = path.join(OUTPUT, 'scale-300.orogen');

const SOURCES = ['generate/fractal-noise', 'generate/mountain-range', 'generate/cellular-noise', 'generate/island', 'generate/dunes'];
const STEPS = [
  'filter/blur', 'surface/terraces', 'adjust/levels', 'adjust/math', 'filter/sharpen', 'select/slope', 'filter/warp', 'adjust/combine',
  'surface/roughen', 'color/gradient-map', 'color/hue-saturation', 'filter/transform', 'adjust/math', 'surface/strata', 'adjust/combine', 'filter/median',
];

/** 300 nodes in rows of twenty: each row a chain from a generator, with a wire from the row above into every node that takes a second input. */
function generate(): { doc: GraphDoc; grid: string[][] } {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { buildResolution: 1009, previewLevel: 2 });
  const grid: string[][] = [];
  for (let row = 0; row < ROWS; row++) {
    const ids: string[] = [];
    for (let column = 0; column < COLUMNS; column++) {
      const type = column === 0 ? SOURCES[row % SOURCES.length]! : STEPS[(column - 1 + row) % STEPS.length]!;
      const id = addNode(draft, REGISTRY, type, { x: column * 280, y: row * 160 });
      ids.push(id);
      if (column === 0) continue;
      const def = REGISTRY.get(type)!;
      connect(draft, REGISTRY, { node: ids[column - 1]!, port: 'out' }, { node: id, port: def.inputs[0]!.name });
      const second = def.inputs[1];
      if (second) connect(draft, REGISTRY, { node: row > 0 ? grid[row - 1]![column - 1]! : ids[Math.max(0, column - 2)]!, port: 'out' }, { node: id, port: second.name });
    }
    grid.push(ids);
  }
  const frame = (id: string, title: string, color: string, column: number, row: number, columns: number, rows: number): void =>
    setGroup(draft, { id, title, color, rect: { x: column * 280 - 20, y: row * 160 - 44, w: columns * 280 - 16, h: rows * 160 + 12 } });
  frame('sources', 'Sources', '#79461d', 0, 0, 1, ROWS);
  frame('upper', 'Upper block', '#246283', 4, 2, 6, 4);
  frame('lower', 'Lower block', '#1d725e', 11, 8, 7, 5);
  return { doc: draft as GraphDoc, grid };
}

interface Timing { readonly name: string; readonly steps: number; readonly median: number; readonly p95: number; readonly max: number; readonly mean: number }

function summarise(name: string, times: readonly number[]): Timing {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
  const round = (ms: number): number => Math.round(ms * 100) / 100;
  return { name, steps: times.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!), mean: round(times.reduce((sum, ms) => sum + ms, 0) / times.length) };
}

/**
 * Installs `graphScale.run(steps)` in the page: each step is a function of graphTest's input; its time runs
 * from the call until the page has rendered what it led to and has been laid out.
 */
const SCALE_PAGE = `(() => {
  const turn = () => new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
  const root = document.querySelector('[data-graph="root"]');
  window.graphScale = {
    async run(steps) {
      const times = [];
      for (const step of steps) {
        const from = performance.now();
        step();
        await turn();
        void root.getBoundingClientRect();
        void root.querySelector('.react-flow__viewport').offsetWidth;
        times.push(performance.now() - from);
      }
      return times;
    },
    /** A drag held down: the press, a first small move, then \`count\` moves of (dx, dy), each timed; then the release. */
    async drag(from, dx, dy, count, init = {}) {
      graphTest.down(from.x, from.y, init);
      graphTest.move(from.x + Math.sign(dx) * 3, from.y + Math.sign(dy) * 3, init);
      await turn();
      const steps = [];
      for (let i = 1; i <= count; i++) steps.push(() => graphTest.move(from.x + dx * i, from.y + dy * i, init));
      const times = await this.run(steps);
      graphTest.up(from.x + dx * count, from.y + dy * count, init);
      await turn();
      return times;
    },
  };
  return true;
})()`;

test('scale: a graph of 300 nodes is panned, zoomed, dragged and box-selected, and the time of every step is reported', async (t) => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { doc: generated, grid } = generate();
  fs.writeFileSync(FILE, serializeDoc(generated));
  const edgeCount = Object.keys(generated.edges).length;
  assert.equal(Object.keys(generated.nodes).length, 300);
  t.diagnostic(`the project: 300 nodes, ${edgeCount} wires, 3 groups (${path.relative(process.cwd(), FILE)})`);

  await withApp({ open: FILE }, async (app) => {
    await ready(app);
    await docked(app);
    await graphSettled(app);
    await focusGraph(app);
    await app.eval(SCALE_PAGE);
    const timings: Timing[] = [];
    const record = (name: string, times: readonly number[]): void => {
      const timing = summarise(name, times);
      timings.push(timing);
      t.diagnostic(`${name.padEnd(46)} median ${String(timing.median).padStart(6)} ms   95th ${String(timing.p95).padStart(6)} ms   max ${String(timing.max).padStart(6)} ms   (${timing.steps} steps)`);
    };

    // ---- everything is there, fitted, and drawn at the level of detail of its zoom ----
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-graph="root"] [data-node]').length`), 300);
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge').length`), edgeCount);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-group]').length`), 3);
    const fitted = await drawn(app);
    assert.ok(fitted.zoom < 0.3, `300 nodes fit into the panel only far out: ${fitted.zoom}`);
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'far');
    assert.equal(await app.eval<string>(`getComputedStyle(document.querySelector('[data-node] canvas')).display`), 'none', 'no thumbnail is drawn at this zoom');
    t.diagnostic(`fitted at a zoom of ${fitted.zoom.toFixed(3)}; DOM elements under the graph: ${await app.eval<number>(`document.querySelector('[data-graph="root"]').querySelectorAll('*').length`)}`);
    t.diagnostic(`capture: ${await capture(app, 'scale-01-300-nodes-fitted')}`);

    const box = await graphBox(app);
    const centre: Point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // A point of the canvas between two rows, where a press meets no node: found by looking.
    const free = await app.eval<Point | null>(`(() => {
      for (let y = ${box.y + 60}; y < ${box.y + box.height - 20}; y += 3) {
        for (let x = ${box.x + 40}; x < ${box.x + box.width - 220}; x += 7) {
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      return null;
    })()`);
    assert.ok(free, 'the canvas shows through somewhere');

    // ---- pan, all 300 nodes in view ----
    const beforePan = await drawn(app);
    record('pan, 300 nodes in view (zoom ' + fitted.zoom.toFixed(2) + ')', await app.eval<number[]>(`graphScale.drag(${quote(free)}, 4, 2, 60, { button: 1 })`));
    const afterPan = await drawn(app);
    assert.ok(Math.abs(afterPan.x - beforePan.x - 240) < 6 && Math.abs(afterPan.y - beforePan.y - 120) < 6, 'the graph was panned by the drag');
    await app.eval(`graphScale.drag(${quote({ x: free.x + 240, y: free.y + 120 })}, -4, -2, 60, { button: 1 })`);

    // ---- zoom with the wheel across the levels of detail and back ----
    const wheel = (deltas: readonly number[]): Promise<number[]> =>
      app.eval<number[]>(`graphScale.run(${quote(deltas)}.map((delta) => () => graphTest.wheel(${centre.x}, ${centre.y}, delta)))`);
    record('zoom by the wheel, far out and across the detail', await wheel([...Array<number>(10).fill(-60), ...Array<number>(10).fill(60), ...Array<number>(10).fill(-60), ...Array<number>(10).fill(60)]));
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'far');

    // ---- drag: one node, fifty, and all 300, every node in view ----
    const one = grid[7]![9]!;
    const grab = async (id: string): Promise<Point> => {
      const node = await nodeBox(app, id);
      return { x: node.x + node.width / 3, y: node.y + 2 };
    };
    const steps = (await history(app)).length;
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);
    const startOne = (await docOf(app)).nodes[one]!.position;
    record('drag 1 node, 300 in view', await app.eval<number[]>(`graphScale.drag(${quote(await grab(one))}, 2, 1, 60)`));
    const movedOne = (await docOf(app)).nodes[one]!.position;
    assert.ok(movedOne.x > startOne.x + 100 / fitted.zoom && movedOne.y > startOne.y + 50 / fitted.zoom, 'the node was moved by the drag');
    assert.deepEqual((await history(app)).slice(steps), ['Move'], 'sixty pointer moves are one step');

    const fifty = grid.slice(4, 9).flatMap((row) => row.slice(5, 15));
    assert.equal(fifty.length, 50);
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: ${quote(fifty)} })`);
    const startFifty = (await docOf(app)).nodes[fifty[0]!]!.position;
    record('drag 50 nodes together, 300 in view', await app.eval<number[]>(`graphScale.drag(${quote(await grab(fifty[12]!))}, 2, 1, 60)`));
    const moved = await docOf(app);
    assert.ok(fifty.every((id) => moved.nodes[id]!.position.x > generated.nodes[id]!.position.x + 100 / fitted.zoom || id === one), 'all fifty moved');
    assert.ok(moved.nodes[fifty[0]!]!.position.x > startFifty.x);
    assert.deepEqual((await history(app)).slice(steps), ['Move', 'Move']);

    await key(app, 'KeyA', { ctrl: true });
    assert.equal((await selection(app)).length, 300);
    record('drag all 300 nodes together', await app.eval<number[]>(`graphScale.drag(${quote(await grab(grid[2]![3]!))}, 1, 1, 40)`));
    assert.deepEqual((await history(app)).slice(steps), ['Move', 'Move', 'Move']);
    for (let i = 0; i < 3; i++) await key(app, 'KeyZ', { ctrl: true });
    assert.deepEqual((await docOf(app)).nodes[one]!.position, startOne, 'three steps back, everything is where it was');
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);

    // ---- a box drawn across the whole graph: the selection grows with every move ----
    const corner = { x: box.x + 30, y: box.y + 46 };
    record('box selection growing over the graph', await app.eval<number[]>(`graphScale.drag(${quote(corner)}, ${(box.width - 80) / 40}, ${(box.height - 70) / 40}, 40)`));
    const boxed = (await selection(app)).length;
    assert.ok(boxed > 150, `the box selected what it covered: ${boxed} nodes`);
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge.selected').length`), 0, 'a box selects nodes, not their wires');
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);

    // ---- close up: a dozen nodes in view, with thumbnails ----
    // What the graph asks the engine for from here on (runtime.md 7.1: the nodes whose thumbnails it shows).
    await app.eval(`void (() => {
      const engine = orogenTest.ctx.engine;
      const ask = engine.requestThumbnails.bind(engine);
      window.graphAsked = [];
      engine.requestThumbnails = (ids) => { if (window.graphAsked.length < 200) window.graphAsked.push([...ids]); ask(ids); };
    })()`);
    const target = await nodeBox(app, grid[7]![9]!);
    const at = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    for (let tick = 0; tick < 30 && (await drawn(app)).zoom < 1; tick++) await app.eval(`void graphTest.wheel(${at.x}, ${at.y}, -100)`);
    const close = await drawn(app);
    assert.ok(close.zoom >= 1, `zoomed in: ${close.zoom}`);
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'near');
    await app.waitFor(`document.querySelectorAll('[data-thumbnail="drawn"]').length >= 4`, 60_000);
    const visible = await app.eval<number>(`(() => {
      const view = document.querySelector('[data-graph="root"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-graph="root"] [data-node]')].filter((node) => { const r = node.getBoundingClientRect(); return r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom; }).length;
    })()`);
    const thumbnails = await app.eval<number>(`document.querySelectorAll('[data-thumbnail="drawn"]').length`);
    t.diagnostic(`close up at a zoom of ${close.zoom.toFixed(2)}: ${visible} of the 300 nodes in view, ${thumbnails} thumbnails drawn`);
    // 7.1: the graph asks for the thumbnails of the nodes it shows, not for those of all 300.
    assert.ok(thumbnails < 100, `thumbnails were made for what is in view and what the zoom passed over: ${thumbnails}`);
    // The list it last gave the engine is the nodes in view: every one of them, and none that lies outside.
    const inView = (margin: number): string => `(() => {
      const view = document.querySelector('[data-graph="root"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-graph="root"] [data-node]')].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > view.left + ${margin} && r.left < view.right - ${margin} && r.bottom > view.top + ${margin} && r.top < view.bottom - ${margin};
      }).map((node) => node.getAttribute('data-node'));
    })()`;
    // The list follows the view a moment after it has come to rest: one asked for while the zoom still passed over more is not the last.
    await app.waitFor(`(() => {
      const last = window.graphAsked.at(-1);
      const inside = ${inView(3)};
      const around = new Set(${inView(-3)});
      return last !== undefined && last.length > 0 && inside.every((id) => last.includes(id)) && last.every((id) => around.has(id));
    })()`, PAGE_BACKSTOP_MS);
    const asked = await app.eval<string[]>(`window.graphAsked.at(-1)`);
    const around = new Set(await app.eval<string[]>(inView(-3)));
    assert.ok(asked.length >= 4 && asked.length < 40, `asked for ${asked.length} thumbnails with ${visible} nodes in view`);
    assert.deepEqual(asked.filter((id) => !around.has(id)), [], 'no thumbnail is asked for of a node outside the panel');
    t.diagnostic(`capture: ${await capture(app, 'scale-02-300-nodes-close-up')}`);
    const gap = await app.eval<Point | null>(`(() => {
      for (let y = ${box.y + 60}; y < ${box.y + box.height - 20}; y += 3) {
        for (let x = ${box.x + 60}; x < ${box.x + box.width - 260}; x += 5) {
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') && document.elementFromPoint(x + 3, y + 3)?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      return null;
    })()`);
    assert.ok(gap, 'the canvas shows between the nodes');
    record('pan, close up (zoom ' + close.zoom.toFixed(2) + ', ' + visible + ' nodes in view)', await app.eval<number[]>(`graphScale.drag(${quote(gap)}, 5, 2, 60, { button: 1 })`));
    await app.eval(`graphScale.drag(${quote({ x: gap.x + 300, y: gap.y + 120 })}, -5, -2, 60, { button: 1 })`);
    const near = grid[7]![9]!;
    const nearBox = await nodeBox(app, near);
    record('drag 1 node, close up', await app.eval<number[]>(`graphScale.drag(${quote({ x: nearBox.x + 40, y: nearBox.y + 10 })}, 2, 1, 60)`));
    record('zoom by the wheel, close up', await wheel([...Array<number>(8).fill(40), ...Array<number>(8).fill(-40), ...Array<number>(8).fill(40), ...Array<number>(8).fill(-40)]));
    await key(app, 'KeyZ', { ctrl: true });

    // ---- the whole graph again, by its key ----
    await key(app, 'Home');
    await app.waitFor(`graphTest.lod() === 'far'`, PAGE_BACKSTOP_MS);
    // Far out no thumbnail is drawn, and none is asked for.
    await app.waitFor(`window.graphAsked.at(-1).length === 0`, PAGE_BACKSTOP_MS);

    const report = {
      measured: 'script, render and layout per input step in a window that was never shown; painting and compositing are not included',
      nodes: 300, wires: edgeCount, groups: 3, fittedZoom: fitted.zoom, closeZoom: close.zoom, nodesInViewCloseUp: visible, timings,
    };
    fs.writeFileSync(path.join(OUTPUT, 'scale-300.json'), `${JSON.stringify(report, null, 2)}\n`);
    t.diagnostic(`report: ${path.join(OUTPUT, 'scale-300.json')}`);
  });
});
