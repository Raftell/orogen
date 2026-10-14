// Every kind of parameter, edited on real nodes by synthesised input (runtime.md 8.7 rules 5 and 6): after each
// edit the document holds the value, the history has one entry more (one for a whole drag), and the engine has
// computed another picture. The curve and the gradient are in editors.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { FieldStats } from '../../../src/core/api.ts';
import { addNode, connect, setView, type PortRef } from '../../../src/core/runtime.ts';
import { fromHex } from '../../../src/app/ui/color.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  apart, appears, attrOf, capture, choose, contentKey, count, differs, enter, exists, field, FOLDER, future, inspect, key, nodeState, PAGE_BACKSTOP_MS, PANEL, paramOf,
  past, press, project, quote, rectOf, redo, ROOT, row, scrub, select, settled, textOf, undo, vanishes, widthOf, withProject,
} from './rig.ts';

const ids = { noise: '', range: '', shape: '', levels: '', solid: '', landscape: '', imported: '' };

const FILE = project('kinds', (draft, registry) => {
  ids.noise = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 0 });
  ids.range = addNode(draft, registry, 'generate/mountain-range', { x: 0, y: 200 });
  ids.shape = addNode(draft, registry, 'generate/shape', { x: 0, y: 400 });
  ids.solid = addNode(draft, registry, 'color/constant', { x: 0, y: 600 });
  ids.imported = addNode(draft, registry, 'io/import-field', { x: 0, y: 800 });
  ids.levels = addNode(draft, registry, 'adjust/levels', { x: 300, y: 0 });
  ids.landscape = addNode(draft, registry, 'io/export-landscape', { x: 600, y: 0 });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.levels, port: 'in' });
  connect(draft, registry, { node: ids.levels, port: 'out' }, { node: ids.landscape, port: 'in' });
  setView(draft, { height: { node: ids.noise, port: 'out' } });
});

/** What the engine made of a node: the key of its content, the run that made it and, of a field that is shown, its statistics. */
interface Picture { readonly key: string | undefined; readonly run: { readonly requestId: number; readonly cached: boolean; readonly state: string }; readonly stats: FieldStats | null }

async function picture(app: AppDriver, ref: PortRef): Promise<Picture> {
  await settled(app);
  return {
    key: await contentKey(app, ref.node),
    run: await app.eval<Picture['run']>(`(() => { const node = orogenTest.ctx.engineState.getState().nodes[${quote(ref.node)}]; return { requestId: node.requestId, cached: node.cached, state: node.state }; })()`),
    stats: await inspect(app, ref),
  };
}

/**
 * Runs the edit and asserts that it made one history entry with this label and that the engine shows another
 * picture: the node has another content key, was evaluated for it, and the field shown has other statistics.
 * `look: 'run'` is for an edit that moves or turns a shape and leaves its statistics as they were: there the
 * node must have run, not been taken from the cache. (A reset is taken from the cache, and has other statistics.)
 */
async function edits(app: AppDriver, ref: PortRef, label: string, edit: () => Promise<void>, look: 'statistics' | 'run' = 'statistics'): Promise<void> {
  const before = await picture(app, ref);
  const entries = await past(app);
  await edit();
  const after = await picture(app, ref);
  const now = await past(app);
  assert.equal(now.length, entries.length + 1, `"${label}" is one history entry: ${now.slice(entries.length).map((entry) => entry.label).join(', ')}`);
  assert.equal(now[now.length - 1]!.label, label);
  assert.notEqual(after.key, before.key, `${label}: the node has another content key`);
  assert.ok(after.run.state === 'done' && after.run.requestId > before.run.requestId, `${label}: the node was evaluated again: ${JSON.stringify(after.run)} after ${JSON.stringify(before.run)}`);
  if (look === 'statistics') assert.ok(differs(after.stats, before.stats), `${label}: another field is shown, ${JSON.stringify(after.stats)} after ${JSON.stringify(before.stats)}`);
  else assert.equal(after.run.cached, false, `${label}: the node ran for its new content`);
}

const near = (actual: number, expected: number, tolerance: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

test('kinds: float, int, enum and seed are dragged, typed, chosen and drawn; a drag is one history entry and is drafted', async (t) => {
  await withProject(FILE, async (app) => {
    const out: PortRef = { node: ids.noise, port: 'out' };
    await select(app, [ids.noise], { height: out });
    await settled(app);
    assert.deepEqual(await past(app), []);

    // ---- float: a drag across a part of the field is that part of the range ----
    const gain = field('gain');
    const width = await widthOf(app, gain);
    await edits(app, out, 'Fractal Noise: Roughness', () => scrub(app, gain, 40));
    near(await paramOf<number>(app, ids.noise, 'gain'), 0.5 + 40 / width, 1e-6, 'a drag of 40 pixels');
    assert.equal((await past(app)).at(-1)!.mergeKey, `param:${ids.noise}:gain`, 'the merge key of runtime.md 8.5 rule 4');
    assert.equal(await attrOf(app, row('gain'), 'data-changed'), '', 'the row is marked as changed');

    // While the button is down the document is in a gesture and the engine shows drafts; letting go refines.
    await apart();
    const before = await past(app);
    await scrub(app, gain, -60, {}, false);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), `param:${ids.noise}:gain`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().view?.draft === true`, PAGE_BACKSTOP_MS);
    const drafted = await app.eval<{ resolution: number }>(`orogenTest.ctx.engineState.getState().view`);
    assert.ok(drafted.resolution < 505, `a draft is coarser than the preview: ${drafted.resolution}`);
    await app.eval(`void shellTest.release(${quote(gain)})`);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), null);
    await settled(app);
    assert.deepEqual(await app.eval<unknown>(`(() => { const view = orogenTest.ctx.engineState.getState().view; return [view.draft, view.resolution]; })()`), [false, 505]);
    assert.equal((await past(app)).length, before.length + 1, 'the second drag is one entry too');

    // Escape during a drag: the value it began with, and no entry.
    await apart();
    const held = await paramOf<number>(app, ids.noise, 'gain');
    const entries = (await past(app)).length;
    await scrub(app, gain, 50, {}, false);
    assert.notEqual(await paramOf<number>(app, ids.noise, 'gain'), held);
    await key(app, 'Escape', {}, gain);
    await app.eval(`void shellTest.release(${quote(gain)})`);
    assert.equal(await paramOf<number>(app, ids.noise, 'gain'), held);
    assert.equal((await past(app)).length, entries, 'a drag that was taken back leaves nothing to undo');
    assert.equal(await future(app), 0, 'and nothing to redo: no entry that changes nothing is left behind (cancelGesture, runtime.md 8.5 rule 4)');
    // What could be redone before such a drag still can: the drag has cost no redo step.
    await undo(app);
    const undone = await paramOf<number>(app, ids.noise, 'gain');
    assert.deepEqual([(await past(app)).length, await future(app)], [entries - 1, 1]);
    await scrub(app, gain, 50, {}, false);
    assert.equal(await future(app), 0, 'while it lasts, the drag is a change like any other');
    await key(app, 'Escape', {}, gain);
    await app.eval(`void shellTest.release(${quote(gain)})`);
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'gain'), (await past(app)).length, await future(app)], [undone, entries - 1, 1]);
    await redo(app);
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'gain'), (await past(app)).length, await future(app)], [held, entries, 0], 'the redo that was there before the drag');
    await settled(app);

    // The reset of the row: the default, one entry, the mark gone.
    await edits(app, out, 'Fractal Noise: Reset Roughness', () => press(app, `${row('gain')} [data-action="reset"]`));
    assert.equal(await paramOf<number>(app, ids.noise, 'gain'), 0.5);
    assert.equal(await attrOf(app, row('gain'), 'data-changed'), null);
    assert.equal(await exists(app, `${row('gain')} [data-action="reset"]`), false);

    // A typed entry with arithmetic; a hard limit holds what is typed beyond it.
    await edits(app, out, 'Fractal Noise: Roughness', () => enter(app, gain, '0.2 + 0.1'));
    near(await paramOf<number>(app, ids.noise, 'gain'), 0.3, 1e-12, 'typed arithmetic');
    await enter(app, gain, '25%');
    assert.equal(await paramOf<number>(app, ids.noise, 'gain'), 0.25, 'a ratio is typed in percent');
    await enter(app, gain, '7');
    assert.equal(await paramOf<number>(app, ids.noise, 'gain'), 1);
    await settled(app);

    // ---- a length: the fraction is stored, the metres are beside it, and either is typed (8.7 rule 6) ----
    const size = field('size');
    assert.equal(await textOf(app, `${size} .og-number-value`), '0.250', 'three significant digits on a log scale');
    assert.equal(await textOf(app, `${size} .og-number-secondary`), '1008 m', 'a quarter of 4032 m');
    await edits(app, out, 'Fractal Noise: Feature size', () => enter(app, size, '504m'));
    near(await paramOf<number>(app, ids.noise, 'size'), 0.125, 1e-12, '504 m of 4032 m');
    assert.equal(await textOf(app, `${size} .og-number-value`), '0.125');
    assert.equal(await textOf(app, `${size} .og-number-secondary`), '504 m');
    await enter(app, size, '1.008 km');
    near(await paramOf<number>(app, ids.noise, 'size'), 0.25, 1e-12, '1.008 km');
    await enter(app, size, '0.5');
    assert.equal(await paramOf<number>(app, ids.noise, 'size'), 0.5, 'the fraction itself');
    assert.equal(await textOf(app, `${size} .og-number-secondary`), '2016 m');
    // The range of the slider is soft: a typed length may exceed it; a drag covers it in equal ratios.
    await enter(app, size, '20160m');
    near(await paramOf<number>(app, ids.noise, 'size'), 5, 1e-12, 'five times the terrain, beyond the slider');
    // Whatever is typed is stored, and shown as what it is: a value too small for the decimals of its range does
    // not read as 0, and a huge one has no decimals after ten digits.
    await enter(app, size, '0.0000001');
    assert.equal(await paramOf<number>(app, ids.noise, 'size'), 1e-7);
    assert.equal(await textOf(app, `${size} .og-number-value`), '0.00000010');
    await enter(app, size, '1e9');
    assert.equal(await paramOf<number>(app, ids.noise, 'size'), 1e9);
    assert.equal(await textOf(app, `${size} .og-number-value`), '1000000000');
    await enter(app, size, '1/0');
    assert.equal(await attrOf(app, size, 'data-invalid'), '', 'what is no number is refused, and the entry stays open');
    await key(app, 'Escape', {}, `${size} input`);
    assert.equal(await paramOf<number>(app, ids.noise, 'size'), 1e9);
    await enter(app, size, '0.1');
    const sizeWidth = await widthOf(app, size);
    await scrub(app, size, 30);
    near(await paramOf<number>(app, ids.noise, 'size'), 0.1 * (4 / 0.001) ** (30 / sizeWidth), 1e-6, 'a drag on a log scale');
    await settled(app);

    // ---- int ----
    const octaves = field('octaves');
    await edits(app, out, 'Fractal Noise: Octaves', () => scrub(app, octaves, -70));
    const dragged = await paramOf<number>(app, ids.noise, 'octaves');
    assert.ok(Number.isInteger(dragged) && dragged >= 1 && dragged < 8, `octaves ${dragged}`);
    await enter(app, octaves, '5.6');
    assert.equal(await paramOf<number>(app, ids.noise, 'octaves'), 6);
    await enter(app, octaves, '99');
    assert.equal(await paramOf<number>(app, ids.noise, 'octaves'), 16);
    await enter(app, octaves, '4');
    await settled(app);

    // ---- enum ----
    assert.equal(await textOf(app, `${row('mode')} .og-select-value`), 'Rolling');
    await edits(app, out, 'Fractal Noise: Mode', () => choose(app, row('mode'), 'ridged'));
    assert.equal(await paramOf<string>(app, ids.noise, 'mode'), 'ridged');
    assert.equal(await textOf(app, `${row('mode')} .og-select-value`), 'Ridged');

    // ---- seed: the dice, and a typed number ----
    await edits(app, out, 'Fractal Noise: Seed', () => press(app, `${row('seed')} [data-command="inspector.randomizeSeed"]`));
    const drawn = await paramOf<number>(app, ids.noise, 'seed');
    assert.ok(Number.isInteger(drawn) && drawn > 0 && drawn <= 2 ** 32 - 1, `seed ${drawn}`);
    await enter(app, field('seed'), '42');
    assert.equal(await paramOf<number>(app, ids.noise, 'seed'), 42);
    await settled(app);

    // ---- a group is a section that closes and opens; its parameters are edited like the others ----
    const warp = `${PANEL} [data-section="Warp"]`;
    assert.equal(await attrOf(app, `${warp} > button`, 'aria-expanded'), 'true');
    await edits(app, out, 'Fractal Noise: Warp', () => scrub(app, field('warpStrength'), 50));
    assert.equal(await textOf(app, `${warp} > button`), 'Warp1 changed');
    await press(app, `${warp} > button`);
    assert.equal(await exists(app, row('warpStrength')), false, 'a closed section draws no rows');
    assert.equal(await attrOf(app, `${warp} > button`, 'aria-expanded'), 'false');
    await press(app, `${warp} > button`);
    assert.equal(await exists(app, row('warpSize')), true);

    // ---- the help of a parameter is the tooltip of its label; the context menu of a row resets it ----
    await app.eval(`void shellTest.hover(${quote(`${row('octaves')} label`)})`);
    await appears(app, '[data-ui="tooltip"]');
    const help = await textOf(app, '[data-ui="tooltip"]');
    assert.match(help, /Default 8\. Range 1 to 16\.$/, help);
    assert.ok(help.length > 40, 'the help text comes first');
    t.diagnostic(`capture: ${await capture(app, 'kinds-numbers')}`);
    await app.eval(`void shellTest.secondary(${quote(row('octaves'))})`);
    await appears(app, '[data-ui="menu"] [data-item="reset"]');
    await edits(app, out, 'Fractal Noise: Reset Octaves', () => press(app, '[data-ui="menu"] [data-item="reset"]'));
    assert.equal(await paramOf<number>(app, ids.noise, 'octaves'), 8);
    await vanishes(app, '[data-ui="menu"]');

    // ---- the reset of the node: every parameter at its default, in one entry, and one undo brings all back ----
    assert.ok(await count(app, `${PANEL} [data-param][data-changed]`) >= 4);
    await edits(app, out, 'Fractal Noise: Reset Parameters', () => press(app, `${PANEL} [data-command="inspector.resetAll"]`));
    assert.equal(await count(app, `${PANEL} [data-param][data-changed]`), 0);
    assert.deepEqual((await app.eval<Record<string, unknown>>(`orogenTest.ctx.doc.getState().doc.nodes[${quote(ids.noise)}].params`)), {
      mode: 'fbm', size: 0.25, octaves: 8, gain: 0.5, lacunarity: 2, warpStrength: 0, warpSize: 0.5, seed: 0,
    });
    assert.equal(await app.eval<boolean>(`shellTest.el(${quote(`${PANEL} [data-command="inspector.resetAll"]`)}).disabled`), true);
    await undo(app);
    assert.deepEqual([await paramOf<string>(app, ids.noise, 'mode'), await paramOf<number>(app, ids.noise, 'seed')], ['ridged', 42]);
    await settled(app);
  });
});

test('kinds: a direction by its dial, a height in metres, a vector, a parameter that shows with another, a bool, a color and a text', async (t) => {
  await withProject(FILE, async (app) => {
    // ---- a direction: the dial's hand points as the top view shows it, 0° right and 90° down (8.7 rule 5) ----
    const ridge: PortRef = { node: ids.range, port: 'out' };
    await select(app, [ids.range], { height: ridge });
    await settled(app);
    const dial = `${row('angle')} [data-control="dial"]`;
    const disc = await rectOf(app, dial);
    const centre = { x: disc.x + disc.width / 2, y: disc.y + disc.height / 2 };
    const hand = (): Promise<[number, number]> => app.eval<[number, number]>(`(() => { const line = shellTest.el(${quote(`${dial} line:last-of-type`)}); return [Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))]; })()`);
    const [x0, y0] = await hand();
    assert.ok(x0 > 8 && y0 === 0, `at 0° the hand points right: ${x0}, ${y0}`);

    // A drag from the right of the centre to below it: 90°, one entry.
    await edits(app, ridge, 'Mountain Range: Direction', () =>
      app.eval(`void inspectorTest.drag(${quote(dial)}, ${quote({ x: centre.x + 9, y: centre.y })}, ${quote({ x: centre.x, y: centre.y + 9 })})`), 'run');
    assert.equal(await paramOf<number>(app, ids.range, 'angle'), 90);
    const [x90, y90] = await hand();
    assert.ok(x90 === 0 && y90 > 8, `at 90° the hand points down the screen: ${x90}, ${y90}`);
    assert.equal(await textOf(app, `${field('angle')} .og-number-value`), '90.0°');
    // Ctrl snaps to 15°; the arrow keys turn by a degree, clockwise for the right arrow.
    await app.eval(`void inspectorTest.drag(${quote(dial)}, ${quote({ x: centre.x, y: centre.y + 9 })}, ${quote({ x: centre.x - 9, y: centre.y + 8 })}, { ctrlKey: true })`);
    assert.equal(await paramOf<number>(app, ids.range, 'angle'), 135);
    await key(app, 'ArrowRight', {}, dial);
    assert.equal(await paramOf<number>(app, ids.range, 'angle'), 136);
    await key(app, 'ArrowLeft', { shift: true }, dial);
    assert.equal(await paramOf<number>(app, ids.range, 'angle'), 121);
    // Escape during a turn of the dial takes it back.
    const entries = (await past(app)).length;
    await app.eval(`void inspectorTest.drag(${quote(dial)}, ${quote({ x: centre.x + 9, y: centre.y })}, ${quote({ x: centre.x + 9, y: centre.y - 4 })}, {}, 4, false)`);
    assert.notEqual(await paramOf<number>(app, ids.range, 'angle'), 121);
    await key(app, 'Escape', {}, dial);
    await app.eval(`void inspectorTest.up(${quote(dial)}, ${quote(centre)})`);
    assert.deepEqual([await paramOf<number>(app, ids.range, 'angle'), (await past(app)).length, await future(app)], [121, entries, 0]);
    // The field beside the dial takes degrees.
    await enter(app, field('angle'), '45°');
    assert.equal(await paramOf<number>(app, ids.range, 'angle'), 45);
    await settled(app);

    // ---- a height: metres of the height range ----
    const height = field('height');
    assert.equal(await textOf(app, `${height} .og-number-secondary`), '756 m', 'three quarters of 1008 m');
    await edits(app, ridge, 'Mountain Range: Height', () => enter(app, height, '504m'));
    near(await paramOf<number>(app, ids.range, 'height'), 0.5, 1e-12, '504 m of 1008 m');
    assert.equal(await textOf(app, `${height} .og-number-secondary`), '504 m');
    t.diagnostic(`capture: ${await capture(app, 'kinds-direction')}`);

    // ---- vec2, and a parameter that is shown only while another has a value ----
    const mask: PortRef = { node: ids.shape, port: 'out' };
    await select(app, [ids.shape], { height: mask });
    await settled(app);
    const axis = (name: string, which: 'X' | 'Y'): string => `${row(name)} [data-ui="number-field"][aria-label$=" ${which}"]`;
    assert.equal(await count(app, `${row('center')} [data-ui="number-field"]`), 2);
    assert.equal(await textOf(app, `${axis('center', 'X')} .og-number-secondary`), '2016 m');
    await edits(app, mask, 'Shape: Center', () => enter(app, axis('center', 'X'), '1008m'), 'run');
    const typed = await paramOf<number[]>(app, ids.shape, 'center');
    near(typed[0]!, 0.25, 1e-12, '1008 m of 4032 m');
    assert.equal(typed[1], 0.5);
    await apart();
    await edits(app, mask, 'Shape: Center', () => scrub(app, axis('center', 'Y'), 40), 'run');
    const center = await paramOf<number[]>(app, ids.shape, 'center');
    assert.ok(center[0] === typed[0] && center[1]! > 0.5, `only Y moved: ${center.join(', ')}`);

    assert.equal(await exists(app, row('count')), false, 'the sides of a polygon are hidden for an ellipse');
    await edits(app, mask, 'Shape: Mode', () => choose(app, row('mode'), 'polygon'));
    await appears(app, row('count'));
    await edits(app, mask, 'Shape: Sides', () => enter(app, field('count'), '3'));
    assert.equal(await paramOf<number>(app, ids.shape, 'count'), 3);
    await choose(app, row('mode'), 'rectangle');
    assert.equal(await exists(app, row('count')), false);
    assert.equal(await paramOf<number>(app, ids.shape, 'count'), 3, 'a hidden parameter keeps its value');
    await settled(app);

    // ---- bool ----
    const levelled: PortRef = { node: ids.levels, port: 'out' };
    await select(app, [ids.levels], { height: levelled });
    await settled(app);
    const clamp = await paramOf<boolean>(app, ids.levels, 'clamp');
    const before = await contentKey(app, ids.levels);
    await press(app, `${row('clamp')} [data-ui="checkbox"]`);
    assert.equal(await paramOf<boolean>(app, ids.levels, 'clamp'), !clamp);
    assert.deepEqual((await past(app)).at(-1), { label: 'Levels: Clamp', mergeKey: `param:${ids.levels}:clamp` });
    await settled(app);
    assert.notEqual(await contentKey(app, ids.levels), before);
    assert.equal(await attrOf(app, `${row('clamp')} [data-ui="checkbox"]`, 'data-checked'), clamp ? null : '');

    // ---- color: a hex code, and a drag in the picker as one entry ----
    await select(app, [ids.solid], { height: { node: ids.noise, port: 'out' }, overlay: { ref: { node: ids.solid, port: 'out' }, as: 'color', opacity: 1 } });
    await settled(app);
    const swatch = `${row('color')} [data-ui="color-swatch"]`;
    const solid = await contentKey(app, ids.solid);
    await press(app, swatch);
    await appears(app, '[data-ui="color-picker"]');
    const hex = '[data-ui="color-picker"] [data-ui="text-field"]';
    await app.eval(`void (shellTest.focus(${quote(hex)}), shellTest.type(${quote(hex)}, '#ff8000'))`);
    await key(app, 'Enter', {}, hex);
    assert.deepEqual(await paramOf<number[]>(app, ids.solid, 'color'), [...fromHex('#ff8000')!], 'the document holds linear RGB');
    assert.equal((await past(app)).at(-1)!.label, 'Solid Color: Color');
    assert.equal(await textOf(app, `${row('color')} [data-color-code]`), '#ff8000');
    await settled(app);
    assert.notEqual(await contentKey(app, ids.solid), solid);
    await apart();
    const area = await rectOf(app, '.react-colorful__saturation');
    const picked = (await past(app)).length;
    await app.eval(`void inspectorTest.mouseDrag('.react-colorful__saturation .react-colorful__interactive', ${quote({ x: area.x + 20, y: area.y + 20 })}, ${quote({ x: area.x + area.width - 2, y: area.y + 2 })})`);
    const color = await paramOf<number[]>(app, ids.solid, 'color');
    assert.ok(Math.max(...color) > 0.9 && Math.min(...color) < 0.1, `a saturated, bright color: ${color.join(', ')}`);
    assert.equal((await past(app)).length, picked + 1, 'a drag in the picker is one entry');
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), null, 'and its gesture has ended');
    t.diagnostic(`capture: ${await capture(app, 'kinds-color')}`);
    // A drag across the square ends outside the popover as often as inside: the purest colors lie at its edges.
    // The button is let go over the viewport, where no element of the picker hears of it.
    await apart();
    await settled(app);
    const outside = (await past(app)).length;
    await app.eval(`void (() => {
      const square = document.querySelector('.react-colorful__saturation .react-colorful__interactive');
      const elsewhere = document.querySelector('[data-panel="viewport"]');
      const send = (target, type, x, y) => target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
        bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y,
      }));
      send(square, 'pointerdown', ${area.x + 30}, ${area.y + 30});
      send(square, 'mousedown', ${area.x + 30}, ${area.y + 30});
      send(square, 'pointermove', ${area.x + 80}, ${area.y + 60});
      send(square, 'mousemove', ${area.x + 80}, ${area.y + 60});
    })()`);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), `param:${ids.solid}:color`, 'the press in the picker began the gesture');
    await app.eval(`void (() => {
      const elsewhere = document.querySelector('[data-panel="viewport"]');
      const send = (target, type) => target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
        bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 400, clientY: 300,
      }));
      send(elsewhere, 'pointermove');
      send(window, 'mousemove');
      send(elsewhere, 'pointerup');
      send(window, 'mouseup');
    })()`);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), null, 'the gesture ends where the button is let go');
    assert.equal((await past(app)).length, outside + 1, 'one entry');
    assert.equal(await exists(app, '[data-ui="color-picker"]'), true, 'the picker stays open');
    await settled(app);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.engineState.getState().view.draft`), false, 'and the engine has refined what the drag left');
    // The next drag is a gesture of its own, and an entry of its own.
    await apart();
    await app.eval(`void inspectorTest.mouseDrag('.react-colorful__saturation .react-colorful__interactive', ${quote({ x: area.x + 40, y: area.y + 40 })}, ${quote({ x: area.x + 90, y: area.y + 20 })})`);
    assert.deepEqual([(await past(app)).length, await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`)], [outside + 2, null]);
    await key(app, 'Escape', {}, '[data-ui="color-picker"]');
    await vanishes(app, '[data-ui="color-picker"]');
    await settled(app);

    // ---- text, and a bool of an export node ----
    await select(app, [ids.landscape]);
    const name = `${row('name')} [data-ui="text-field"]`;
    assert.equal(await app.eval<string>(`shellTest.el(${quote(name)}).value`), 'Orogen');
    const exported = await contentKey(app, ids.landscape);
    await app.eval(`void (shellTest.focus(${quote(name)}), shellTest.type(${quote(name)}, 'Alps'))`);
    assert.equal(await paramOf<string>(app, ids.landscape, 'name'), 'Orogen', 'typing stores nothing');
    await key(app, 'Enter', {}, name);
    assert.equal(await paramOf<string>(app, ids.landscape, 'name'), 'Alps');
    assert.equal((await past(app)).at(-1)!.label, 'Unreal Landscape: Name');
    await app.waitFor(`orogenTest.ctx.engineState.getState().keys[${quote(ids.landscape)}] !== ${quote(exported)}`, PAGE_BACKSTOP_MS);
    // A text that is taken back with Escape is not stored.
    await app.eval(`void shellTest.type(${quote(name)}, 'Nothing')`);
    await key(app, 'Escape', {}, name);
    assert.equal(await paramOf<string>(app, ids.landscape, 'name'), 'Alps');
    // visibleWhen across the node: the fixed range shows its two heights in place of the headroom.
    assert.deepEqual([await exists(app, row('headroom')), await exists(app, row('heightMin'))], [true, false]);
    await choose(app, row('rangeMode'), 'fixed');
    assert.deepEqual([await exists(app, row('headroom')), await exists(app, row('heightMin')), await exists(app, row('heightMax'))], [false, true, true]);
    assert.equal(await textOf(app, `${field('heightMax')} .og-number-secondary`), '1008 m');
  });
});

test('kinds: a file is chosen in the dialog of the bridge, shown by its name, said to be missing, and read again', async (t) => {
  // The file the node is to read: a copy beside the project, and a place where no file is yet.
  const asset = path.join(ROOT, 'tests/graphs/assets/heights-253.png');
  const beside = path.join(FOLDER, 'kinds-heights.png');
  const later = path.join(FOLDER, 'kinds-later.png');
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.copyFileSync(asset, beside);
  fs.rmSync(later, { force: true });

  await withProject(FILE, async (app) => {
    const out: PortRef = { node: ids.imported, port: 'out' };
    const control = `${row('file')} [data-control="file"]`;
    await select(app, [ids.imported], { height: out });
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}]?.state === 'error'`);

    // No file yet: the control says so, and so does the node.
    assert.equal(await attrOf(app, control, 'data-state'), 'empty');
    assert.equal(await textOf(app, `${control} [data-action="choose"]`), 'No file selected');
    assert.equal(await app.eval<boolean>(`shellTest.el(${quote(`${control} [data-action="reload"]`)}).disabled`), true);
    assert.equal(await textOf(app, `${PANEL} [data-node-error] span`), 'No file selected');

    // A cancelled dialog changes nothing.
    await press(app, `${control} [data-action="browse"]`);
    await app.eval(`new Promise((resolve) => setTimeout(resolve, 100))`);
    assert.equal(await paramOf<string>(app, ids.imported, 'file'), '');

    // The dialog answers with a file beside the project: its path is stored relative to the project (engine.md 4.12).
    await app.eval(`void orogenTest.shell.answers.openFileDialog.push(${quote(beside)})`);
    await press(app, `${control} [data-action="browse"]`);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.nodes[${quote(ids.imported)}].params.file !== ''`, PAGE_BACKSTOP_MS);
    assert.equal(await paramOf<string>(app, ids.imported, 'file'), 'kinds-heights.png');
    assert.deepEqual((await past(app)).at(-1), { label: 'Import Heightmap: File', mergeKey: `param:${ids.imported}:file` });
    await settled(app);
    assert.equal(await nodeState(app, ids.imported), 'done');
    assert.equal(await attrOf(app, control, 'data-state'), 'chosen');
    assert.equal(await textOf(app, `${control} [data-action="choose"]`), 'kinds-heights.png');
    assert.deepEqual([await textOf(app, `${control} [data-file-stem]`), await textOf(app, `${control} [data-file-extension]`)], ['kinds-heights', '.png']);
    // The control lies below its label and is as wide as the panel: a name of this length is not cut.
    const [named, panel] = [await rectOf(app, `${control} [data-action="choose"]`), await rectOf(app, PANEL)];
    assert.ok(named.width > panel.width * 0.6, `the name has ${named.width} of ${panel.width} pixels`);
    assert.equal(await app.eval<boolean>(`(() => { const stem = shellTest.el(${quote(`${control} [data-file-stem]`)}); return stem.scrollWidth <= stem.clientWidth; })()`), true, 'the name is whole');
    const stats = await inspect(app, out);
    assert.ok(stats !== null && stats.max > stats.min, `the file is the terrain shown: ${JSON.stringify(stats)}`);
    t.diagnostic(`capture: ${await capture(app, 'kinds-file')}`);

    // A press on the name opens the dialog as well. This file does not exist: the node fails and the control says why.
    await app.eval(`void orogenTest.shell.answers.openFileDialog.push(${quote(later)})`);
    await press(app, `${control} [data-action="choose"]`);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.nodes[${quote(ids.imported)}].params.file === 'kinds-later.png'`, PAGE_BACKSTOP_MS);
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}]?.state === 'error'`);
    await appears(app, `${control}[data-state="missing"]`);
    assert.equal(await textOf(app, `${control} [data-file-problem]`), 'File not found');
    const said = await textOf(app, `${PANEL} [data-node-error] span`);
    assert.match(said, /^File not found: .*kinds-later\.png$/, `the head of the panel has the whole message: ${said}`);
    assert.equal(await textOf(app, `${PANEL} [data-error-fact="Kind"] dd`), 'File');
    assert.equal(await textOf(app, `${control} [data-action="choose"]`), 'kinds-later.png');
    t.diagnostic(`capture: ${await capture(app, 'kinds-file-missing')}`);

    // The file appears, and Reload has the engine look again: a new request, and the node computes. The engine
    // watches the file too and may have seen it first, so what the button does is counted where it does it: it
    // tells the session its project again (runtime.md 7.1).
    await app.eval(`void (() => {
      const engine = orogenTest.ctx.engine;
      const tell = engine.setProject;
      window.inspectorReloads = [];
      engine.setProject = function (project) { window.inspectorReloads.push(project.path); return tell.call(this, project); };
    })()`);
    fs.copyFileSync(asset, later);
    const request = await app.eval<number>(`orogenTest.ctx.engineState.getState().viewRequestId`);
    await press(app, `${control} [data-action="reload"]`);
    assert.deepEqual(await app.eval<(string | null)[]>(`window.inspectorReloads`), [FILE], 'the button told the session its project again, once');
    await app.waitFor(`orogenTest.ctx.engineState.getState().viewRequestId > ${request}`, PAGE_BACKSTOP_MS);
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}]?.state === 'done'`);
    await appears(app, `${control}[data-state="chosen"]`);
    assert.equal(await exists(app, `${control} [data-file-problem]`), false);

    // A name too long for the panel is cut in its stem and keeps its extension, which tells an image from its
    // sidecar; the tooltip has the whole path.
    const long = path.join(FOLDER, 'kinds-N46E007-swissalti3d-2m-heightmap-16bit-final-v2-resampled-and-cropped.tif');
    await app.eval(`void orogenTest.shell.answers.openFileDialog.push(${quote(long)})`);
    await press(app, `${control} [data-action="browse"]`);
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.nodes[${quote(ids.imported)}].params.file === ${quote(path.basename(long))}`, PAGE_BACKSTOP_MS);
    const cut = await app.eval<{ stem: [number, number]; extension: [number, number, string]; button: number }>(`(() => {
      const stem = shellTest.el(${quote(`${control} [data-file-stem]`)});
      const extension = shellTest.el(${quote(`${control} [data-file-extension]`)});
      return {
        stem: [stem.clientWidth, stem.scrollWidth],
        extension: [extension.clientWidth, extension.scrollWidth, extension.textContent],
        button: shellTest.el(${quote(`${control} [data-action="choose"]`)}).getBoundingClientRect().right - extension.getBoundingClientRect().right,
      };
    })()`);
    assert.ok(cut.stem[1] > cut.stem[0], `the stem is cut: ${cut.stem.join(' of ')}`);
    assert.ok(cut.extension[2] === '.tif' && cut.extension[1] <= cut.extension[0] && cut.button >= 0, `the extension is whole and inside the field: ${JSON.stringify(cut)}`);
    t.diagnostic(`capture: ${await capture(app, 'kinds-file-long-name')}`);

    // The reset of the row is no file again.
    await press(app, `${row('file')} [data-action="reset"]`);
    assert.equal(await paramOf<string>(app, ids.imported, 'file'), '');
    assert.equal((await past(app)).at(-1)!.label, 'Import Heightmap: Reset File');
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.imported)}]?.state === 'error'`);
  });
  fs.rmSync(later, { force: true });
  fs.rmSync(beside, { force: true });
});
