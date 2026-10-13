// The whole application where it is strained: a project of 300 nodes that is selected in, scrubbed, panned,
// dragged and undone; and an edit during which the GPU process is killed, and another during which the engine is
// restarted, after each of which the viewport and the thumbnails are back.
//
// What is measured is reported and nothing is asserted on a duration (testing.md 8.5): the assertions are on what
// the input did, each wait with a backstop. Captures: test-output/ui/gate-robustness/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { addNode, connect, createRegistry, newDoc, serializeDoc, setParam, setSettings, setView, type DocDraft, type GraphDoc } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { gpuProcesses } from '../platform/rig.ts';
import {
  addedNode, appears, boxOf, capture as captureIn, cut, docOf, drawnShare, EVALUATION_BACKSTOP_MS, graphClick, graphDrag, graphHover, graphSettled, graphWheel, history,
  inspect, keyPress, nodeBox, OUTPUT, PAGE_BACKSTOP_MS, pageSize, press, quote, sameField, selection, selectNode, settled, showTab, start, text, typeInto, vanishes,
} from './gate-rig.ts';

const REGISTRY = createRegistry(nodes);
const SHOTS = 'gate-robustness';
const FOLDER = path.join(OUTPUT, 'gate-robustness');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });
fs.rmSync(path.join(OUTPUT, 'ui', SHOTS), { recursive: true, force: true });
const capture = (app: AppDriver, name: string): Promise<string> => captureIn(app, SHOTS, name);

const PALETTE = '[data-graph="palette"]';
const INSPECTOR = '[data-panel="inspector"]';
const CHAINS = 100;

/** 300 nodes: a hundred chains of noise, blur and levels, ten to a row. The view is the end of the first chain. */
function threeHundred(): { file: string; first: { noise: string; blur: string; levels: string } } {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { buildResolution: 1009, previewLevel: 1 });
  let first = { noise: '', blur: '', levels: '' };
  for (let chain = 0; chain < CHAINS; chain++) {
    const x = (chain % 10) * 900;
    const y = Math.floor(chain / 10) * 220;
    const noise = addNode(draft, REGISTRY, 'generate/fractal-noise', { x, y });
    const blur = addNode(draft, REGISTRY, 'filter/blur', { x: x + 280, y });
    const levels = addNode(draft, REGISTRY, 'adjust/levels', { x: x + 560, y });
    setParam(draft, REGISTRY, noise, 'seed', chain);
    connect(draft, REGISTRY, { node: noise, port: 'out' }, { node: blur, port: 'in' });
    connect(draft, REGISTRY, { node: blur, port: 'out' }, { node: levels, port: 'in' });
    if (chain === 0) first = { noise, blur, levels };
  }
  setView(draft, { height: { node: first.levels, port: 'out' } });
  const file = path.join(FOLDER, 'three-hundred.orogen');
  fs.writeFileSync(file, serializeDoc(draft as GraphDoc));
  return { file, first };
}

/** How long the page takes to come back to a task that waits for nothing: what a person feels as lag. */
const lag = (app: AppDriver): Promise<number> => app.eval<number>(`new Promise((resolve) => { const from = performance.now(); setTimeout(() => resolve(performance.now() - from), 0); })`);

/** Runs a step and returns how long it took, with the page's lag right after it. */
async function timed(app: AppDriver, step: () => Promise<void>): Promise<{ ms: number; lagMs: number }> {
  const from = performance.now();
  await step();
  const ms = performance.now() - from;
  return { ms: Math.round(ms), lagMs: Math.round(await lag(app)) };
}

/** The share of a thumbnail's pixels that are painted, and whether they are more than one colour. */
const thumbnail = (app: AppDriver, id: string): Promise<{ painted: number; varied: boolean } | null> => app.eval(`(() => {
  const canvas = document.querySelector('[data-graph="root"] [data-node="${id}"] [data-thumbnail="drawn"] canvas') ?? document.querySelector('[data-graph="root"] [data-node="${id}"] canvas');
  if (!canvas || canvas.width === 0) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0, low = 255, high = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) painted++;
    if (data[i] < low) low = data[i];
    if (data[i] > high) high = data[i];
  }
  return { painted: painted / (data.length / 4), varied: high - low > 20 };
})()`);

/** The nodes whose thumbnails the panel shows now: in view, near enough to be drawn. */
const nodesInView = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`(() => {
  const pane = document.querySelector('[data-graph="root"]').getBoundingClientRect();
  return [...document.querySelectorAll('[data-graph="root"] [data-node]')].filter((node) => {
    const box = node.getBoundingClientRect();
    return node.querySelector('canvas') !== null && box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom;
  }).map((node) => node.getAttribute('data-node'));
})()`);

/** A place of the graph's panel where nothing lies but the canvas: a press there selects nothing. */
async function emptyPlace(app: AppDriver): Promise<{ x: number; y: number }> {
  const found = await app.eval<{ x: number; y: number } | null>(`(() => {
    const pane = document.querySelector('[data-graph="root"]').getBoundingClientRect();
    for (let fy = 0.92; fy > 0.05; fy -= 0.06) {
      for (let fx = 0.96; fx > 0.03; fx -= 0.05) {
        const x = Math.round(pane.left + pane.width * fx), y = Math.round(pane.top + pane.height * fy);
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      }
    }
    return null;
  })()`);
  assert.ok(found !== null, 'the panel has a place without a node');
  return found;
}

/** The nodes in view that show a thumbnail. */
const drawnInView = async (app: AppDriver): Promise<string[]> => {
  const inView = await nodesInView(app);
  return app.eval<string[]>(`${JSON.stringify(inView)}.filter((id) => document.querySelector('[data-graph="root"] [data-node="' + id + '"] [data-thumbnail="drawn"]') !== null)`);
};

/** Brings the nodes near enough to read: the wheel over one of them. */
async function zoomTo(app: AppDriver, id: string): Promise<void> {
  const block = await nodeBox(app, id);
  const over = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
  await graphHover(app, over);
  for (let tick = 0; tick < 16 && (await app.eval<string>(`graphTest.lod()`)) !== 'near'; tick++) await graphWheel(app, over, -120);
  assert.equal(await app.eval<string>(`graphTest.lod()`), 'near');
  await graphSettled(app);
}

test('gate: a project of 300 nodes stays usable: selecting, scrubbing, panning, dragging all of it, adding and undoing', async (t) => {
  const { file, first } = threeHundred();
  const app = await start({ open: file });
  try {
    await app.waitFor(`orogenTest.ctx.doc.getState().path !== null`, PAGE_BACKSTOP_MS);
    await settled(app);
    await graphSettled(app);
    assert.equal(Object.keys((await docOf(app)).nodes).length, 300);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-graph="root"] [data-node]').length`), 300, 'every node is in the graph');
    assert.equal(await app.eval<string>(`graphTest.lod()`), 'far', 'fitted, 300 nodes are blocks of colour');
    const measured: Record<string, { ms: number; lagMs: number }> = {};
    await capture(app, '01-three-hundred-fitted');

    // ---- near: the first chain, read and selected ----
    await showTab(app, 'Inspector');
    measured.zoom = await timed(app, () => zoomTo(app, first.blur));
    measured.select = await timed(app, async () => {
      await selectNode(app, first.blur);
      await app.waitFor(`document.querySelector('${INSPECTOR} [aria-label="Node title"]')?.value === 'Blur'`, PAGE_BACKSTOP_MS);
    });
    await settled(app);
    const shown = { node: first.blur, port: 'out' };
    assert.deepEqual((await docOf(app)).ui.view?.height, shown);
    const before = await inspect(app, shown);

    // ---- a long scrub of one parameter: two hundred moves in one gesture, drafted, then refined ----
    const radius = `${INSPECTOR} [data-param="radius"] [data-ui="number-field"]`;
    await appears(app, radius);
    measured.scrub = await timed(app, async () => {
      await app.eval(`void shellTest.drag(${quote(radius)}, 20, {}, 4, false)`);
      for (let round = 0; round < 10; round++) {
        // Twenty moves, back and forth, and then the page gets its turn: as a hand does it.
        await app.eval(`void (() => {
          const field = document.querySelector(${quote(radius)});
          const box = field.getBoundingClientRect();
          for (let step = 0; step < 20; step++) {
            const x = box.left + box.width / 2 + 20 + ((${round} * 20 + step) % 40) * (step % 2 ? 1 : 1.5);
            field.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, clientX: x, clientY: box.top + box.height / 2 }));
          }
        })()`);
      }
    });
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), `param:${first.blur}:radius`);
    await app.eval(`void shellTest.release(${quote(radius)})`);
    measured.refine = await timed(app, () => settled(app));
    assert.deepEqual(await history(app), ['Blur: Radius'], 'two hundred moves are one step');
    assert.ok(!sameField(await inspect(app, shown), before), 'the blur with another radius is another terrain');
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.engineState.getState().evaluation`), null, 'nothing is left running');
    await capture(app, '02-scrubbed');

    // ---- the thumbnails of the nodes in view are drawn ----
    const inView = await nodesInView(app);
    assert.ok(inView.length >= 3, `nodes are in view: ${inView.length}`);
    await app.waitFor(`${JSON.stringify(inView)}.every((id) => document.querySelector('[data-graph="root"] [data-node="' + id + '"] [data-thumbnail="drawn"]') !== null)`, EVALUATION_BACKSTOP_MS);
    for (const id of inView) assert.equal((await thumbnail(app, id))?.painted, 1, `the thumbnail of ${id}`);

    // ---- panning with the middle button: forty moves, and the document has the new place ----
    const pane = await boxOf(app, '[data-graph="root"]');
    const held = (await docOf(app)).ui.graphViewport!;
    measured.pan = await timed(app, async () => {
      await graphDrag(app, { x: pane.x + pane.width * 0.6, y: pane.y + pane.height * 0.8 }, { x: pane.x + pane.width * 0.6 - 300, y: pane.y + pane.height * 0.8 - 80 }, { button: 1 }, 40);
      await app.waitFor(`Math.abs((orogenTest.ctx.doc.getState().doc.ui.graphViewport?.x ?? 0) - ${held.x - 300}) < 4`, PAGE_BACKSTOP_MS);
    });
    assert.deepEqual(await history(app), ['Blur: Radius'], 'panning is no step');

    // ---- all 300 selected, and dragged as one: one step, undone as one ----
    await graphClick(app, await emptyPlace(app));
    measured.selectAll = await timed(app, async () => {
      await keyPress(app, 'KeyA', { ctrl: true });
      await app.waitFor(`orogenTest.ctx.ui.getState().selection.length === 300`, PAGE_BACKSTOP_MS);
      await app.waitFor(`document.querySelector('${INSPECTOR} [data-field="count"]')?.textContent === '300 nodes selected'`, PAGE_BACKSTOP_MS);
    });
    const places = (await docOf(app)).nodes;
    const [anchor] = await nodesInView(app);
    assert.ok(anchor, 'a node is in view to drag by');
    const grip = await app.eval<{ x: number; y: number }>(`graphTest.title(${quote(anchor)})`);
    measured.dragAll = await timed(app, async () => {
      await graphDrag(app, grip, { x: grip.x + 60, y: grip.y + 40 }, {}, 30);
      await app.waitFor(`orogenTest.ctx.doc.getState().past.length === 2`, PAGE_BACKSTOP_MS);
    });
    assert.deepEqual(await history(app), ['Blur: Radius', 'Move']);
    const zoom = (await docOf(app)).ui.graphViewport!.zoom;
    const moved = (await docOf(app)).nodes;
    for (const id of [first.noise, first.levels, Object.keys(places)[299]!]) {
      assert.ok(Math.abs(moved[id]!.position.x - places[id]!.position.x - 60 / zoom) < 4 && Math.abs(moved[id]!.position.y - places[id]!.position.y - 40 / zoom) < 4, `${id} moved with the others`);
    }
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.ui.getState().dragPositions`), null);
    measured.undo = await timed(app, async () => {
      await keyPress(app, 'KeyZ', { ctrl: true });
      await app.waitFor(`orogenTest.ctx.doc.getState().past.length === 1`, PAGE_BACKSTOP_MS);
    });
    assert.deepEqual((await docOf(app)).nodes[first.noise]!.position, places[first.noise]!.position);
    await capture(app, '03-all-selected');

    // ---- a node from the palette, wired by dragging, computed, and undone ----
    const free = await emptyPlace(app);
    await graphClick(app, free);
    assert.deepEqual(await selection(app), []);
    await graphHover(app, free);
    const beforeAdd = await docOf(app);
    measured.add = await timed(app, async () => {
      await keyPress(app, 'Tab');
      await appears(app, `${PALETTE} input`);
      await typeInto(app, `${PALETTE} input`, 'terraces');
      await app.waitFor(`document.querySelector(${quote(`${PALETTE} [role="option"][aria-selected="true"][data-type]`)})?.getAttribute('data-type') === 'surface/terraces'`, PAGE_BACKSTOP_MS);
      await keyPress(app, 'Enter', {}, `${PALETTE} input`);
      await vanishes(app, PALETTE);
    });
    const terraces = await addedNode(app, beforeAdd);
    assert.equal(Object.keys((await docOf(app)).nodes).length, 301);
    // Selected, the new node is what the viewport is asked for, and it has no input yet: every panel says so in
    // the same words, none of them calls it a failure, and the picture that was shown stays.
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(terraces)}]?.state === 'error'`, EVALUATION_BACKSTOP_MS);
    await showTab(app, 'Inspector');
    await appears(app, `${INSPECTOR} [data-missing-input]`);
    await app.waitFor(`document.querySelector('[data-viewport="state"]')?.textContent === 'Missing input'`, PAGE_BACKSTOP_MS);
    const said = {
      graph: await text(app, `[data-node="${terraces}"] [data-role="status"]`),
      inspector: await text(app, `${INSPECTOR} [data-status-text]`),
      viewport: await text(app, '[data-viewport="state"]'),
      statusBar: await text(app, '[data-status="errors"]'),
    };
    await capture(app, '03b-node-without-input');
    assert.deepEqual(said, { graph: 'Missing input: In', inspector: 'Missing input: In', viewport: 'Missing input', statusBar: '1 node lacks an input' });
    assert.deepEqual(await app.eval<unknown>(`[
      document.querySelector('[data-node="${terraces}"]').hasAttribute('data-failed'), document.querySelector('${INSPECTOR} [data-node-error]') !== null,
      document.querySelector('[data-viewport="status"]').getAttribute('data-state'), document.querySelector('[data-status="errors"]').getAttribute('data-tone'),
    ]`), [false, false, 'unwired', 'warning'], 'unfinished, not failed, in the graph, the inspector, the viewport and the status bar');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="cover"]') === null`), true, 'the last picture stays');
    measured.afterAdd = await timed(app, async () => {
      await keyPress(app, 'KeyZ', { ctrl: true });
      await app.waitFor(`!Object.hasOwn(orogenTest.ctx.doc.getState().doc.nodes, ${quote(terraces)})`, PAGE_BACKSTOP_MS);
    });
    await settled(app);

    // ---- fitted again, and the build panel lists nothing to export without a word of complaint from the page ----
    await graphClick(app, await emptyPlace(app));
    await keyPress(app, 'Home');
    await app.waitFor(`graphTest.lod() === 'far'`, PAGE_BACKSTOP_MS);
    await showTab(app, 'Build');
    await appears(app, '[data-panel="build"] [data-build="panel"]');
    await showTab(app, 'Library');
    await appears(app, '[data-panel="library"] [data-library="root"]');
    measured.idle = await timed(app, () => settled(app));
    await capture(app, '04-three-hundred-after');
    t.diagnostic(`300 nodes, time of each step and the page's lag right after it (ms): ${Object.entries(measured).map(([name, m]) => `${name} ${m.ms}/${m.lagMs}`).join(', ')}`);
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});

test('gate: the GPU process killed in the middle of an edit, and the engine restarted in the middle of another: the viewport and the thumbnails are back', async (t) => {
  const app = await start();
  try {
    // The alpine example, near enough to read, its erosion selected.
    await showTab(app, 'Library');
    await press(app, '[data-panel="library"] [data-tab="examples"]');
    await appears(app, '[data-library="examples"] [data-example="alpine-range"]');
    await press(app, '[data-library="examples"] [data-example="alpine-range"] [data-action="open"]');
    await app.waitFor(`Object.hasOwn(orogenTest.ctx.doc.getState().doc.nodes, 'hydraulic')`, PAGE_BACKSTOP_MS);
    await settled(app);
    await graphSettled(app);
    await showTab(app, 'Inspector');
    await zoomTo(app, 'hydraulic');
    await selectNode(app, 'hydraulic');
    await settled(app);
    const erosion = { node: 'hydraulic', port: 'out' };
    const eroded = await inspect(app, erosion);
    const rain = `${INSPECTOR} [data-param="rain"] [data-ui="number-field"]`;

    // The nodes in view that show a thumbnail before anything is lost: the erosion chain. (A mask behind a
    // simulation that the view does not need has none until it is selected: runtime.md 7.3 rule 9.)
    await app.waitFor(`document.querySelector('[data-graph="root"] [data-node="hydraulic"] [data-thumbnail="drawn"]') !== null`, EVALUATION_BACKSTOP_MS);
    const pictured = await drawnInView(app);
    for (const id of ['base', 'fluvial', 'hydraulic']) assert.ok(pictured.includes(id), `${id} shows a thumbnail: ${pictured.join(', ')}`);
    /** What must be back: the terrain on a canvas that presents, and a painted thumbnail on every node that showed one. */
    const back = async (name: string): Promise<void> => {
      await settled(app, 120_000);
      const page = await pageSize(app);
      const file = await capture(app, name);
      const picture = cut(file, await boxOf(app, '[data-viewport="canvas"]'), page);
      assert.ok(drawnShare(picture) > 0.2, `the viewport shows a terrain again: ${drawnShare(picture).toFixed(3)} of its pixels are not the background`);
      assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="cover"]') === null`), true, 'nothing covers the picture');
      await app.waitFor(`${JSON.stringify(pictured)}.every((id) => document.querySelector('[data-graph="root"] [data-node="' + id + '"] [data-thumbnail="drawn"]') !== null)`, 120_000);
      for (const id of pictured) {
        const drawn = await thumbnail(app, id);
        assert.ok(drawn !== null && drawn.painted === 1 && drawn.varied, `the thumbnail of ${id} is a picture again: ${JSON.stringify(drawn)}`);
      }
      assert.equal(await text(app, '[data-status="device"]'), 'Ready');
      t.diagnostic(`${name}: the viewport and the thumbnails of ${pictured.length} nodes are there (${file})`);
    };
    await back('05-before-the-loss');

    // ---- 1. the button is down on a parameter, the pointer has moved: the GPU process is killed ----
    // The GPU process is found through /proc: on Linux. Elsewhere the edit is made on a device that stays.
    const killed = process.platform === 'linux';
    await app.eval(`void (window.gateEvents = [], orogenTest.ctx.engine.subscribe((e) => {
      if (e.type === 'device-lost' || e.type === 'device-ready' || e.type === 'engine-error') window.gateEvents.push(e.type);
    }))`);
    await app.eval(`void (window.gateCanvas = document.querySelector('[data-viewport="canvas"] canvas'))`);
    await app.eval(`void shellTest.drag(${quote(rain)}, 40, {}, 6, false)`);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), 'param:hydraulic:rain');
    if (killed) {
      const pids = gpuProcesses();
      assert.equal(pids.length, 1, `one application, one GPU process: ${pids.join(', ')}`);
      process.kill(pids[0]!, 'SIGKILL');
      await app.waitFor(`window.gateEvents.includes('device-lost')`, EVALUATION_BACKSTOP_MS);
    }
    // The hand goes on dragging while the device is away, and lets go.
    await app.eval(`void (() => {
      const field = document.querySelector(${quote(rain)});
      const box = field.getBoundingClientRect();
      for (let step = 0; step < 6; step++) field.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, clientX: box.left + box.width / 2 + 40 + step * 4, clientY: box.top + box.height / 2 }));
    })()`);
    if (killed) await app.waitFor(`window.gateEvents.includes('device-ready')`, EVALUATION_BACKSTOP_MS);
    await app.eval(`void shellTest.release(${quote(rain)})`);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), null);
    assert.deepEqual(await app.eval<string[]>(`window.gateEvents`), killed ? ['device-lost', 'device-ready'] : []);
    await back('06-after-the-gpu-process-was-killed');
    assert.deepEqual(await history(app), ['Gullies and Fans: Rain'], 'the drag through the loss is one step');
    const wetter = await inspect(app, erosion);
    assert.ok(!sameField(wetter, eroded), 'the new device computed the edit');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="canvas"] canvas') !== window.gateCanvas`), killed, 'the viewport gave the new device a canvas of its own');
    // And the edit is undone on the new device as on the old.
    await keyPress(app, 'KeyZ', { ctrl: true });
    await settled(app, 120_000);
    assert.ok(sameField(await inspect(app, erosion), eroded, 1e-4), 'undo shows the terrain of before the drag');

    // ---- 2. another drag, and the engine is restarted from its menu while the button is down ----
    await app.eval(`void (window.gateCanvas = document.querySelector('[data-viewport="canvas"] canvas'))`);
    await app.eval(`void shellTest.drag(${quote(rain)}, 40, {}, 6, false)`);
    await press(app, '.og-menubar-item[data-menu="Engine"]');
    await appears(app, '[data-ui="menu"][data-menu="Engine"] [data-item="engine.restart"]');
    await press(app, '[data-ui="menu"][data-menu="Engine"] [data-item="engine.restart"]');
    await app.eval(`void shellTest.release(${quote(rain)})`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready' && document.querySelector('[data-viewport="canvas"] canvas') !== window.gateCanvas`, EVALUATION_BACKSTOP_MS);
    await app.eval(`void [...document.querySelectorAll('[data-ui="notice"] [aria-label="Dismiss"]')].forEach((button) => shellTest.press(button))`);
    await back('07-after-the-engine-was-restarted');
    const again = await inspect(app, erosion);
    assert.ok(again !== null && again.nonFinite === 0 && !sameField(again, eroded), `the new engine computed the edit: ${JSON.stringify(again)}`);
    assert.deepEqual(await history(app), ['Gullies and Fans: Rain'], 'the drag through the restart is one step');
    assert.equal(await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`), await app.eval<number>(`orogenTest.ctx.doc.getState().engineRevision`));
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});
