// The inspector as a person sees it (testing.md 8.5 rule 1): one capture for each kind of thing it shows. Each
// capture is written twice, the whole window and the inspector alone (<name>-panel.png). The test asserts what
// the panel holds at each moment; nobody compares the pictures' pixels.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addNode, connect, setNodeFlags, setParam, setView } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { appears, attrOf, capture, count, field, PAGE_BACKSTOP_MS, PANEL, press, project, quote, rectOf, row, select, settled, textOf, withProject } from './rig.ts';

const ids = { noise: '', range: '', erosion: '', curve: '', gradient: '', landscape: '', shape: '', blur: '', second: '', failing: '' };

const FILE = project('captures', (draft, registry) => {
  ids.noise = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 0 });
  ids.second = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 200 });
  ids.range = addNode(draft, registry, 'generate/mountain-range', { x: 0, y: 400 });
  ids.shape = addNode(draft, registry, 'generate/shape', { x: 0, y: 600 });
  ids.erosion = addNode(draft, registry, 'simulate/hydraulic-erosion', { x: 300, y: 0 });
  ids.curve = addNode(draft, registry, 'adjust/curve', { x: 300, y: 200 });
  ids.gradient = addNode(draft, registry, 'color/gradient-map', { x: 300, y: 400 });
  ids.blur = addNode(draft, registry, 'filter/blur', { x: 300, y: 600 });
  ids.landscape = addNode(draft, registry, 'io/export-landscape', { x: 600, y: 0 });
  ids.failing = addNode(draft, registry, 'ref/fail', { x: 600, y: 200 });
  for (const to of [ids.erosion, ids.curve, ids.gradient, ids.blur, ids.landscape, ids.failing]) {
    connect(draft, registry, { node: ids.noise, port: 'out' }, { node: to, port: 'in' });
  }
  setParam(draft, registry, ids.noise, 'size', 0.4);
  setParam(draft, registry, ids.noise, 'warpStrength', 0.3);
  setParam(draft, registry, ids.second, 'octaves', 5);
  setParam(draft, registry, ids.erosion, 'duration', 0.5);
  setParam(draft, registry, ids.failing, 'message', 'The ground gave way');
  setParam(draft, registry, ids.range, 'angle', 135);
  setNodeFlags(draft, ids.range, { title: 'Main Ridge' });
  setView(draft, { height: { node: ids.noise, port: 'out' } });
});

const header = (member: string): string => `${PANEL} [data-field="${member}"]`;

test('captures: the inspector for the settings, a simple node, a simulation, groups, a curve, a gradient, several nodes and a failed node', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);

    // ---- nothing selected: the project settings ----
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'settings');
    t.diagnostic(`capture: ${await capture(app, 'settings')}`);

    // ---- a simple node: a generator with a direction, lengths, a height and a seed ----
    await select(app, [ids.range], { height: { node: ids.range, port: 'out' } });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    assert.equal(await app.eval<string>(`shellTest.el(${quote(header('title'))}).value`), 'Main Ridge');
    assert.equal(await count(app, `${PANEL} [data-param]`), 8);
    assert.equal(await count(app, `${row('angle')} [data-control="dial"]`), 1, 'a direction has a dial');
    t.diagnostic(`capture: ${await capture(app, 'simple-node')}`);

    // ---- a simulation ----
    await select(app, [ids.erosion], { height: { node: ids.erosion, port: 'out' } });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    assert.equal(await count(app, `${PANEL} [data-param]`), 10);
    assert.match(await textOf(app, `${PANEL} [data-status-text]`), /^Computed · /);
    t.diagnostic(`capture: ${await capture(app, 'simulation-node')}`);

    // ---- groups: no simulation of the product has any; the noise and the landscape export have ----
    await select(app, [ids.noise], { height: { node: ids.noise, port: 'out' } });
    await settled(app);
    assert.deepEqual(await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PANEL} [data-section]`)})].map((s) => s.getAttribute('data-section'))`), ['Warp']);
    t.diagnostic(`capture: ${await capture(app, 'node-with-group')}`);
    await select(app, [ids.landscape]);
    assert.deepEqual(
      await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PANEL} [data-section]`)})].map((s) => s.getAttribute('data-section'))`),
      ['Layers', 'World Partition'],
    );
    t.diagnostic(`capture: ${await capture(app, 'node-with-groups')}`);
    await press(app, `${PANEL} [data-section="Layers"] > button`);
    assert.equal(await attrOf(app, `${PANEL} [data-section="Layers"]`, 'data-open'), null);
    t.diagnostic(`capture: ${await capture(app, 'node-with-groups-one-closed')}`);
    await press(app, `${PANEL} [data-section="Layers"] > button`);

    // ---- a curve ----
    await select(app, [ids.curve], { height: { node: ids.curve, port: 'out' } });
    await settled(app);
    assert.equal(await attrOf(app, `${row('curve')} [data-control="curve"]`, 'data-points'), '4');
    t.diagnostic(`capture: ${await capture(app, 'curve-node')}`);

    // ---- a gradient ----
    await select(app, [ids.gradient], { height: { node: ids.noise, port: 'out' }, overlay: { ref: { node: ids.gradient, port: 'out' }, as: 'color', opacity: 1 } });
    await settled(app);
    assert.ok(Number(await attrOf(app, `${row('gradient')} [data-control="gradient"]`, 'data-stops')) >= 2);
    t.diagnostic(`capture: ${await capture(app, 'gradient-node')}`);

    // ---- several nodes of one type, and of several types ----
    await select(app, [ids.noise, ids.second]);
    assert.equal(await textOf(app, header('count')), '2 × Fractal Noise');
    assert.ok(await count(app, `${PANEL} [data-mixed]`) >= 2, 'the values that differ are marked');
    t.diagnostic(`capture: ${await capture(app, 'two-nodes-of-one-type')}`);
    await select(app, [ids.noise, ids.blur, ids.erosion]);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'summary');
    t.diagnostic(`capture: ${await capture(app, 'nodes-of-several-types')}`);

    // ---- a node with a vector and a parameter that is hidden until another asks for it ----
    await select(app, [ids.shape], { height: { node: ids.shape, port: 'out' } });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    assert.equal(await count(app, `${row('center')} [data-ui="number-field"]`), 2);
    t.diagnostic(`capture: ${await capture(app, 'vector-node')}`);

    // ---- a node that failed ----
    await select(app, [ids.failing], { height: { node: ids.failing, port: 'out' } });
    await app.waitFor(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.failing)}]?.state === 'error'`);
    await appears(app, `${PANEL} [data-node-error]`);
    assert.equal(await textOf(app, `${PANEL} [data-node-error] span`), 'The ground gave way');
    t.diagnostic(`capture: ${await capture(app, 'failed-node')}`);
  });
});

/** Drags the sash between the left column and the side column until the inspector is `width` pixels wide, or as near as the dock lets it be. */
async function widen(app: AppDriver, width: number): Promise<number> {
  const now = (await rectOf(app, PANEL)).width;
  await app.eval(`void shellTest.drag([...document.querySelectorAll('.dv-sash')].find((sash) => sash.getBoundingClientRect().height > 500), ${Math.round(now - width)})`);
  await app.waitFor(`Math.abs(shellTest.rect(${quote(PANEL)}).width - ${now}) > 1`, PAGE_BACKSTOP_MS);
  return (await rectOf(app, PANEL)).width;
}

/** What sticks out of the panel sideways, and whether its body scrolls sideways: neither may be. */
const sideways = (app: AppDriver): Promise<{ out: string[]; scrolls: boolean }> => app.eval(`(() => {
  const panel = shellTest.el(${quote(PANEL)});
  const box = panel.getBoundingClientRect();
  const out = [];
  for (const element of panel.querySelectorAll('[data-inspector-body] *, [data-inspector-header] *')) {
    const r = element.getBoundingClientRect();
    // A select and a checkbox carry a form input of one pixel that nobody sees; it lies where the library puts it.
    if (r.width > 1 && r.height > 1 && (r.right > box.right + 0.5 || r.left < box.left - 0.5)) out.push(element.tagName + ' ' + (element.getAttribute('aria-label') ?? element.textContent ?? '').slice(0, 30));
  }
  const body = panel.querySelector('[data-inspector-body]');
  return { out: out.slice(0, 8), scrolls: body.scrollWidth > body.clientWidth + 1 || panel.querySelector('[data-inspector]').scrollWidth > panel.clientWidth + 1 };
})()`);

test('captures: the panel wide, narrow, narrower than it can be, and in a small window', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);
    await select(app, [ids.shape], { height: { node: ids.shape, port: 'out' } });
    await settled(app);
    const label = `${row('feather')} label`;
    const axis = (which: 'X' | 'Y'): string => `${row('center')} [data-ui="number-field"][aria-label$=" ${which}"]`;

    // ---- as the dock makes it at first: a label beside its control, the two components of a position one above the other ----
    const [l0, f0, x0, y0] = [await rectOf(app, label), await rectOf(app, field('feather')), await rectOf(app, axis('X')), await rectOf(app, axis('Y'))];
    assert.ok(Math.abs((l0.y + l0.height / 2) - (f0.y + f0.height / 2)) <= 2 && f0.x > l0.x + l0.width - 1, 'the label stands beside its field');
    assert.ok(y0.y >= x0.y + x0.height && Math.abs(x0.x - y0.x) <= 1, 'X above Y, so that each has room for its metres');
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });

    // ---- wide: the two components have room side by side ----
    const wide = await widen(app, 620);
    assert.ok(wide >= 480, `the panel is ${wide} pixels wide`);
    const [x1, y1] = [await rectOf(app, axis('X')), await rectOf(app, axis('Y'))];
    assert.ok(Math.abs(x1.y - y1.y) <= 1 && y1.x >= x1.x + x1.width, `X beside Y: ${JSON.stringify([x1, y1])}`);
    assert.equal(await textOf(app, `${axis('Y')} .og-number-secondary`), '2016 m', 'each with its metres');
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });
    t.diagnostic(`capture: ${await capture(app, 'wide-panel')}`);

    // ---- narrow: a row is its label above its control, which then has the panel's width ----
    const narrow = await widen(app, 220);
    assert.ok(narrow < 260 && narrow >= 168, `the panel is ${narrow} pixels wide`);
    const [l2, f2] = [await rectOf(app, label), await rectOf(app, field('feather'))];
    assert.ok(f2.y >= l2.y + l2.height - 1, `the field stands below its label: ${JSON.stringify([l2, f2])}`);
    assert.ok(f2.width >= narrow * 0.7, `and has the width of the panel: ${f2.width} of ${narrow}`);
    assert.equal(await textOf(app, `${field('feather')} .og-number-secondary`), '80.6 m', 'with room for the metres');
    // The title has a line of its own, above the bypass and the reset.
    const [title, bypass] = [await rectOf(app, `${PANEL} [data-field="title"]`), await rectOf(app, `${PANEL} [data-action="bypass"]`)];
    assert.ok(bypass.y >= title.y + title.height - 1 && title.width >= narrow * 0.7, `the title is ${title.width} pixels wide`);
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });
    t.diagnostic(`capture: ${await capture(app, 'narrow-panel')}`);
    for (const id of [ids.curve, ids.gradient, ids.landscape, ids.failing]) {
      await select(app, [id]);
      assert.deepEqual(await sideways(app), { out: [], scrolls: false }, `nothing of ${id} sticks out of a narrow panel`);
    }
    await select(app, [ids.curve]);
    t.diagnostic(`capture: ${await capture(app, 'narrow-panel-curve')}`);
    await select(app, []);
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });
    t.diagnostic(`capture: ${await capture(app, 'narrow-panel-settings')}`);

    // ---- narrower than anything can be read: the panel keeps a least width and is cut off, not crushed ----
    await select(app, [ids.shape]);
    const least = await widen(app, 60);
    assert.ok(least < 168, `the dock made the panel ${least} pixels wide`);
    assert.ok((await rectOf(app, field('feather'))).width >= 120, 'a field keeps a width its number fits into');
    assert.equal(await app.eval<boolean>(`(() => { const root = shellTest.el(${quote(`${PANEL} [data-inspector]`)}); return root.scrollWidth > root.clientWidth; })()`), true, 'what is cut off is reached by scrolling');

    // ---- a small window: the least the application has (960 by 600) ----
    // Last, and without a word about the engine: in a window that was never shown the resize costs the engine its
    // device (measured: "A valid external Instance reference no longer exists"), which is not the inspector's to
    // mend. What is asserted is where the panel's parts lie.
    await app.eval(`void window.resizeTo(960, 600)`);
    await app.waitFor(`innerWidth <= 960 && innerHeight <= 600`, PAGE_BACKSTOP_MS);
    // The dock lays its panels out again for the new window: the inspector ends where the window does.
    await app.waitFor(`(() => { const box = shellTest.rect(${quote(PANEL)}); return box.x + box.width <= innerWidth + 1 && box.y + box.height <= innerHeight + 1; })()`, PAGE_BACKSTOP_MS);
    await widen(app, 300);
    await select(app, [ids.landscape]);
    const small = await rectOf(app, PANEL);
    assert.ok(small.width >= 260, `in the small window the panel is ${small.width} pixels wide`);
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });
    // Its parameters do not fit into the height: the list scrolls, under a head that stays.
    const head = await rectOf(app, `${PANEL} [data-inspector-header]`);
    assert.equal(await app.eval<boolean>(`(() => { const body = shellTest.el(${quote(`${PANEL} [data-inspector-body]`)}); body.scrollTop = body.scrollHeight; return body.scrollTop > 0; })()`), true);
    assert.deepEqual(await rectOf(app, `${PANEL} [data-inspector-header]`), head, 'the head does not scroll away');
    t.diagnostic(`capture: ${await capture(app, 'small-window')}`);
    await select(app, [ids.erosion]);
    assert.deepEqual(await sideways(app), { out: [], scrolls: false });
    assert.equal(await count(app, `${PANEL} [data-param]`), 10);
    t.diagnostic(`capture: ${await capture(app, 'small-window-simulation')}`);
  });
});
