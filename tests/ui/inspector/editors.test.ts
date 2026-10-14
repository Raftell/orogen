// The curve and the gradient editors, driven by a synthesised pointer and keyboard (runtime.md 8.7 rule 5): points
// and stops are added, moved and removed by dragging, each drag is one history entry, the document holds a valid
// curve or gradient after every step, the picture in the editor is evalCurve's and bakeGradient's, and the engine
// computes another terrain.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CurvePoint, GradientStop } from '../../../src/core/api.ts';
import { addNode, connect, setView } from '../../../src/core/runtime.ts';
import { CURVE_PRESETS, curvePath } from '../../../src/app/panels/inspector/curve.ts';
import { colorAt, distributeStops, gradientPixels, PALETTES, reverseStops } from '../../../src/app/panels/inspector/gradient.ts';
import { fromHex, toHex } from '../../../src/app/ui/color.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  apart, appears, attrOf, capture, contentKey, count, differs, enter, inspect, key, PAGE_BACKSTOP_MS, PANEL, paramOf, past, press, project, quote,
  rectOf, row, select, settled, undo, vanishes, withProject, type Rect,
} from './rig.ts';

const ids = { noise: '', curve: '', gradient: '' };

const FILE = project('editors', (draft, registry) => {
  ids.noise = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 0 });
  ids.curve = addNode(draft, registry, 'adjust/curve', { x: 300, y: 0 });
  ids.gradient = addNode(draft, registry, 'color/gradient-map', { x: 300, y: 200 });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.curve, port: 'in' });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.gradient, port: 'in' });
  setView(draft, { height: { node: ids.curve, port: 'out' } });
});

interface Place { readonly x: number; readonly y: number }
const drag = (app: AppDriver, selector: string, from: Place, to: Place, mods: object = {}, release = true): Promise<void> =>
  app.eval<void>(`void inspectorTest.drag(${quote(selector)}, ${quote(from)}, ${quote(to)}, ${JSON.stringify(mods)}, 6, ${release})`);
const entries = async (app: AppDriver): Promise<number> => (await past(app)).length;
const gesture = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`);
const near = (actual: number, expected: number, what: string, tolerance = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected}`);

/** A curve as the document must hold it: x strictly increasing, everything in the unit square. */
function validCurve(points: readonly CurvePoint[], what: string): void {
  assert.ok(points.length >= 2, what);
  points.forEach((p, i) => assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && (i === 0 || p.x > points[i - 1]!.x), `${what}: point ${i} of ${JSON.stringify(points)}`));
}

function validGradient(stops: readonly GradientStop[], what: string): void {
  assert.ok(stops.length >= 2, what);
  stops.forEach((s, i) => assert.ok(s.t >= 0 && s.t <= 1 && (i === 0 || s.t >= stops[i - 1]!.t) && s.color.every((c) => c >= 0 && c <= 1), `${what}: stop ${i} of ${JSON.stringify(stops)}`));
}

test('editors: the points of a curve are dragged, added, held between their neighbours, snapped, removed and typed', async (t) => {
  await withProject(FILE, async (app) => {
    const out = { node: ids.curve, port: 'out' };
    await select(app, [ids.curve], { height: out });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    const plot = `${row('curve')} [data-curve="plot"]`;
    const points = (): Promise<CurvePoint[]> => paramOf<CurvePoint[]>(app, ids.curve, 'curve');
    const pad = Number(await attrOf(app, plot, 'data-pad'));
    const frame: Rect = await rectOf(app, plot);
    const inner = { width: frame.width - 2 * pad, height: frame.height - 2 * pad };
    /** A place of the curve's unit square in the window. */
    const at = (x: number, y: number): Place => ({ x: frame.x + pad + x * inner.width, y: frame.y + pad + (1 - y) * inner.height });
    /** The plot stays where it is whatever the head of the panel says: a place measured once holds for the whole test. */
    const unmoved = async (): Promise<void> => assert.deepEqual(await rectOf(app, plot), frame, 'the plot has not moved');
    const start = await points();
    assert.equal(start.length, 4);
    assert.ok(start[1]!.x === 0.3 && start[1]!.y === 0.06, 'the default curve of the node');

    // What is drawn is evalCurve of the document's points, on the plot as it lies in the window.
    const drawn = (): Promise<string | null> => attrOf(app, `${plot} [data-curve="line"]`, 'd');
    assert.equal(await drawn(), curvePath(start, Math.round(frame.width) - 2 * pad, inner.height));
    assert.equal(await count(app, `${plot} [data-point]`), 4);

    // ---- a press on the plot is the plot's alone ----
    // In a window that has the focus a press gives it to whatever can take it under the pointer, which around a
    // new point is nothing of the curve: Escape and the arrow keys would then miss the point that is dragged. The
    // plot refuses that default, on a point and beside one, and gives the focus to the point itself.
    const pressed = (place: Place): Promise<{ prevented: boolean; focus: string | null }> => app.eval(`(async () => {
      const plot = shellTest.el(${quote(plot)});
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: ${place.x}, clientY: ${place.y} };
      const down = new PointerEvent('pointerdown', { ...init, buttons: 1 });
      plot.dispatchEvent(down);
      await new Promise((done) => setTimeout(done, 50));
      const focus = document.activeElement?.getAttribute('data-point') ?? null;
      // Escape takes back whatever the press did: this is a look at the press, not an edit.
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      plot.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      return { prevented: down.defaultPrevented, focus };
    })()`);
    assert.deepEqual(await pressed(at(0.3, 0.06)), { prevented: true, focus: '1' }, 'a press on a point');
    assert.deepEqual(await pressed(at(0.5, 0.9)), { prevented: true, focus: '2' }, 'a press beside the curve, which adds a point and takes it');
    assert.deepEqual([await points(), await past(app), await gesture(app)], [start, [], null], 'both presses were taken back');

    // ---- a point is dragged: one gesture, one entry, another terrain ----
    const key0 = await contentKey(app, ids.curve);
    const stats0 = await inspect(app, out);
    await drag(app, plot, at(0.3, 0.06), at(0.4, 0.5), {}, false);
    assert.equal(await gesture(app), `param:${ids.curve}:curve`);
    await app.eval(`void inspectorTest.up(${quote(plot)}, ${quote(at(0.4, 0.5))})`);
    assert.equal(await gesture(app), null);
    let now = await points();
    assert.equal(now.length, 4);
    near(now[1]!.x, 0.4, 'the dragged point, x', 1e-4);
    near(now[1]!.y, 0.5, 'the dragged point, y', 1e-4);
    assert.ok(now[0]!.x === 0 && now[2]!.x === 0.7 && now[3]!.y === 1, 'the other points stayed');
    assert.deepEqual(await past(app), [{ label: 'Curve: Curve', mergeKey: `param:${ids.curve}:curve` }]);
    await settled(app);
    assert.notEqual(await contentKey(app, ids.curve), key0);
    assert.ok(differs(await inspect(app, out), stats0), 'the terrain has another profile');
    assert.equal(await drawn(), curvePath(now, Math.round(frame.width) - 2 * pad, inner.height), 'the picture follows the document');
    assert.equal(await attrOf(app, `${plot} [data-point="1"]`, 'data-selected'), '', 'the dragged point is the selected one');

    // ---- a press on the empty plot adds a point there and goes on dragging it: one entry ----
    await apart();
    await drag(app, plot, at(0.55, 0.2), at(0.6, 0.3));
    now = await points();
    assert.equal(now.length, 5);
    near(now[2]!.x, 0.6, 'the new point, x', 1e-4);
    near(now[2]!.y, 0.3, 'the new point, y', 1e-4);
    assert.equal(await entries(app), 2, 'adding a point and dragging it is one entry');
    validCurve(now, 'after adding');
    assert.equal(await attrOf(app, `${row('curve')} [data-control="curve"]`, 'data-points'), '5');

    // ---- a point cannot pass its neighbour: it stops one gap before it ----
    await apart();
    await drag(app, plot, at(0.6, 0.3), at(0.95, 0.3));
    now = await points();
    assert.equal(now[2]!.x, 0.699, 'held before the point at 0.7');
    validCurve(now, 'held between neighbours');

    // ---- Ctrl snaps to sixteenths; Shift moves a tenth as far ----
    await drag(app, plot, at(0.4, 0.5), at(0.33, 0.21), { ctrlKey: true });
    now = await points();
    assert.deepEqual([now[1]!.x, now[1]!.y], [0.3125, 0.1875]);
    await drag(app, plot, at(0.3125, 0.1875), at(0.5125, 0.1875), { shiftKey: true });
    near((await points())[1]!.x, 0.3325, 'a fine drag of 0.2 moves 0.02', 1e-4);

    // ---- Escape during a drag gives the curve back, and nothing to undo ----
    await apart();
    const before = await points();
    const steps = await entries(app);
    await drag(app, plot, at(0.699, 0.3), at(0.5, 0.9), {}, false);
    assert.notEqual((await points())[2]!.y, before[2]!.y);
    await key(app, 'Escape');
    await app.eval(`void inspectorTest.up(${quote(plot)}, ${quote(at(0.5, 0.9))})`);
    assert.ok(JSON.stringify(await points()) === JSON.stringify(before), 'the curve is as it was before the drag');
    assert.deepEqual([await entries(app), await gesture(app)], [steps, null]);

    // ---- a point dragged well outside the plot is removed, in one entry; undo brings it back ----
    await apart();
    await drag(app, plot, at(0.699, 0.3), { x: frame.x + frame.width / 2, y: frame.y + frame.height + 60 });
    now = await points();
    assert.equal(now.length, 4);
    assert.ok(now.every((p) => p.x !== 0.699), 'the point that was pulled out is gone');
    assert.equal(await entries(app), steps + 1);
    await undo(app);
    assert.equal((await points()).length, 5);
    await app.eval(`void orogenTest.ctx.doc.getState().redo()`);
    await settled(app);
    // The node is now shown from the cache, and says so; the plot is where it was.
    await unmoved();
    t.diagnostic(`capture: ${await capture(app, 'curve-edited')}`);

    // ---- a double click on the plot adds one point; a double click on a point removes it ----
    await app.eval(`void inspectorTest.doubleClick(${quote(plot)}, ${quote(at(0.85, 0.5))})`);
    now = await points();
    assert.equal(now.length, 5, 'the second press of the double click did not take the new point away');
    near(now[3]!.x, 0.85, 'the point of the double click', 1e-4);
    await apart();
    await app.eval(`void inspectorTest.doubleClick(${quote(plot)}, ${quote(at(0.85, 0.5))})`);
    assert.equal((await points()).length, 4);

    // ---- the keyboard: every point takes the focus; arrows move it, Delete removes it ----
    const second = `${plot} [data-point="1"]`;
    await app.eval(`void shellTest.focus(${quote(second)})`);
    const held = (await points())[1]!;
    await key(app, 'ArrowUp', {}, second);
    await key(app, 'ArrowRight', { shift: true }, second);
    now = await points();
    near(now[1]!.y, held.y + 0.01, 'one step up');
    near(now[1]!.x, held.x + 0.1, 'ten steps to the right');
    await key(app, 'ArrowLeft', { alt: true }, second);
    near((await points())[1]!.x, held.x + 0.099, 'a fine step back');
    await key(app, 'Delete', {}, second);
    assert.equal((await points()).length, 3);
    await key(app, 'Delete', {}, `${plot} [data-point="1"]`);
    assert.equal((await points()).length, 2);
    await key(app, 'Delete', {}, `${plot} [data-point="1"]`);
    assert.equal((await points()).length, 2, 'a curve keeps two points');
    assert.equal(await app.eval<boolean>(`shellTest.el(${quote(`${row('curve')} [data-action="remove-point"]`)}).disabled`), true);

    // ---- the buttons and the fields of the selected point ----
    await press(app, `${row('curve')} [data-action="add-point"]`);
    now = await points();
    assert.deepEqual([now.length, now[1]!.x], [3, 0.5], 'the button adds a point in the widest gap, on the curve');
    assert.equal(await attrOf(app, `${plot} [data-point="1"]`, 'data-selected'), '');
    const fieldY = `${row('curve')} [data-ui="number-field"][aria-label="Curve point Y"]`;
    const fieldX = `${row('curve')} [data-ui="number-field"][aria-label="Curve point X"]`;
    await enter(app, fieldY, '0.25');
    await enter(app, fieldX, '0.4');
    assert.deepEqual((await points())[1], { x: 0.4, y: 0.25 });
    await enter(app, fieldX, '7');
    assert.equal((await points())[1]!.x, 0.999, 'a typed x is held before the next point as well');
    await press(app, `${row('curve')} [data-action="remove-point"]`);
    assert.equal((await points()).length, 2);

    // ---- presets, and the reset of the row ----
    await press(app, `${row('curve')} [data-action="presets"]`);
    await appears(app, '[data-ui="menu"] [data-item="s-curve"]');
    assert.equal(await count(app, '[data-ui="menu"] [data-item]'), CURVE_PRESETS.length);
    await press(app, '[data-ui="menu"] [data-item="steps"]');
    await vanishes(app, '[data-ui="menu"]');
    const steps8 = CURVE_PRESETS.find((preset) => preset.id === 'steps')!.points;
    assert.ok(JSON.stringify(await points()) === JSON.stringify(steps8), 'the document holds the preset');
    assert.equal((await past(app)).at(-1)!.label, 'Curve: Curve');
    assert.equal(await count(app, `${plot} [data-point]`), steps8.length);
    await settled(app);
    t.diagnostic(`capture: ${await capture(app, 'curve-preset')}`);
    await press(app, `${row('curve')} [data-action="reset"]`);
    assert.ok(JSON.stringify(await points()) === JSON.stringify(start), 'the reset gives the node\'s default curve');
    assert.equal((await past(app)).at(-1)!.label, 'Curve: Reset Curve');
    await settled(app);
    assert.equal(await contentKey(app, ids.curve), key0, 'and with it the terrain the project began with');
  });
});

test('editors: the stops of a gradient are dragged, added, passed over each other, removed, recolored, reversed and replaced by a palette', async (t) => {
  await withProject(FILE, async (app) => {
    await select(app, [ids.gradient], { height: { node: ids.noise, port: 'out' }, overlay: { ref: { node: ids.gradient, port: 'out' }, as: 'color', opacity: 1 } });
    await settled(app);
    const editor = `${row('gradient')} [data-control="gradient"]`;
    const strip = `${editor} [data-gradient="strip"]`;
    const stops = (): Promise<GradientStop[]> => paramOf<GradientStop[]>(app, ids.gradient, 'gradient');
    const stopAt = (index: number): string => `${editor} [data-stop="${index}"]`;
    const centreOf = async (selector: string): Promise<Place> => {
      const box = await rectOf(app, selector);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const band: Rect = await rectOf(app, strip);
    /** A place along the strip in the window, at the height of the stops' markers. */
    const markers = await rectOf(app, stopAt(0));
    const along = (tt: number): Place => ({ x: band.x + tt * band.width, y: markers.y + markers.height / 2 });
    const onStrip = (tt: number): Place => ({ x: band.x + tt * band.width, y: band.y + band.height / 2 });
    const start = await stops();
    assert.equal(start.length, 9, 'the default gradient of the node');
    assert.deepEqual(start.map((stop) => stop.t), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]);
    assert.equal(await count(app, `${editor} [data-stop]`), 9);

    // What is drawn is bakeGradient of the document's stops, in the colors of a screen.
    const pixel = (index: number): Promise<number[]> =>
      app.eval<number[]>(`[...shellTest.el(${quote(strip)}).getContext('2d').getImageData(${index}, 0, 1, 1).data]`);
    const painted = async (held: readonly GradientStop[], what: string): Promise<void> => {
      const expected = gradientPixels(held, 256);
      for (const index of [0, 40, 100, 128, 200, 255]) assert.deepEqual(await pixel(index), [...expected.slice(index * 4, index * 4 + 4)], `${what}: pixel ${index} of the strip`);
    };
    await painted(start, 'the default');
    // The markers stand at their stops and show their colors.
    assert.equal(await attrOf(app, stopAt(4), 'data-color'), toHex(start[4]!.color));
    near((await rectOf(app, stopAt(4))).x + markers.width / 2, along(0.5).x, 'the marker of the stop at 0.5', 1);

    // ---- a stop is dragged: one gesture, one entry, another picture ----
    const key0 = await contentKey(app, ids.gradient);
    await drag(app, stopAt(1), along(0.125), along(0.2), {}, false);
    assert.equal(await app.eval<string | null>(`orogenTest.ctx.doc.getState().gesture`), `param:${ids.gradient}:gradient`);
    await app.eval(`void inspectorTest.up(${quote(stopAt(1))}, ${quote(along(0.2))})`);
    let now = await stops();
    near(now[1]!.t, 0.2, 'the dragged stop', 1e-4);
    assert.deepEqual(now[1]!.color, start[1]!.color);
    assert.deepEqual(await past(app), [{ label: 'Gradient Map: Gradient', mergeKey: `param:${ids.gradient}:gradient` }]);
    await settled(app);
    assert.notEqual(await contentKey(app, ids.gradient), key0);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.gradient)}].cached`), false, 'the node ran for its new gradient');
    await painted(now, 'after a drag');

    // ---- dragged past its neighbour, a stop changes its place in the list and stays the selected one ----
    await apart();
    await drag(app, stopAt(1), along(0.2), along(0.3));
    now = await stops();
    near(now[2]!.t, 0.3, 'the stop behind the one it passed', 1e-4);
    assert.deepEqual([now[1]!.t, now[1]!.color, now[2]!.color], [0.25, start[2]!.color, start[1]!.color]);
    validGradient(now, 'after passing a stop');
    assert.equal(await attrOf(app, stopAt(2), 'data-selected'), '');
    assert.equal((await past(app)).length, 2);

    // ---- a press on the strip adds a stop with the gradient's own color there ----
    await apart();
    const expected = colorAt(now, 0.5625);
    await app.eval(`void inspectorTest.click(${quote(strip)}, ${quote(onStrip(0.5625))})`);
    now = await stops();
    assert.equal(now.length, 10);
    const made = now.findIndex((stop) => Math.abs(stop.t - 0.5625) < 1e-3);
    assert.equal(made, 5);
    for (let c = 0; c < 3; c++) near(now[made]!.color[c]!, expected[c]!, `channel ${c} of the new stop`, 2e-3);
    assert.equal((await past(app)).length, 3);
    assert.equal(await attrOf(app, stopAt(5), 'data-selected'), '');
    validGradient(now, 'after adding');

    // ---- its color: the swatch of the selected stop ----
    await press(app, `${editor} [data-ui="color-swatch"]`);
    await appears(app, '[data-ui="color-picker"]');
    const hex = '[data-ui="color-picker"] [data-ui="text-field"]';
    await app.eval(`void (shellTest.focus(${quote(hex)}), shellTest.type(${quote(hex)}, '#ff8000'))`);
    await key(app, 'Enter', {}, hex);
    now = await stops();
    assert.deepEqual(now[5]!.color, [...fromHex('#ff8000')!]);
    assert.equal(await attrOf(app, stopAt(5), 'data-color'), '#ff8000');
    await key(app, 'Escape', {}, '[data-ui="color-picker"]');
    await vanishes(app, '[data-ui="color-picker"]');
    await settled(app);
    await painted(now, 'after a new color');
    t.diagnostic(`capture: ${await capture(app, 'gradient-edited')}`);

    // A double click on a stop opens its color, and so does Enter while the stop has the focus.
    await app.eval(`void inspectorTest.doubleClick(${quote(stopAt(2))}, ${quote(await centreOf(stopAt(2)))})`);
    await appears(app, '[data-ui="color-picker"]');
    assert.equal(await attrOf(app, stopAt(2), 'data-selected'), '', 'the stop that was clicked is the one whose color is open');
    assert.equal(await attrOf(app, `${editor} [data-ui="color-swatch"]`, 'data-color'), await attrOf(app, stopAt(2), 'data-color'));
    assert.deepEqual(await stops(), now, 'opening a color changes nothing');
    await key(app, 'Escape', {}, '[data-ui="color-picker"]');
    await vanishes(app, '[data-ui="color-picker"]');
    await app.eval(`void shellTest.focus(${quote(stopAt(5))})`);
    await key(app, 'Enter', {}, stopAt(5));
    await appears(app, '[data-ui="color-picker"]');
    assert.equal(await attrOf(app, `${editor} [data-ui="color-swatch"]`, 'data-color'), '#ff8000');
    await key(app, 'Escape', {}, '[data-ui="color-picker"]');
    await vanishes(app, '[data-ui="color-picker"]');
    assert.equal(await gesture(app), null);

    // ---- its position: the field, and the arrow keys on the marker ----
    const position = `${editor} [data-ui="number-field"][aria-label="Gradient stop position"]`;
    await enter(app, position, '0.6');
    assert.equal((await stops())[5]!.t, 0.6);
    await app.eval(`void shellTest.focus(${quote(stopAt(5))})`);
    await key(app, 'ArrowRight', {}, stopAt(5));
    near((await stops())[5]!.t, 0.61, 'one step to the right');
    await key(app, 'ArrowRight', { shift: true }, stopAt(5));
    now = await stops();
    assert.deepEqual([now[6]!.color, now[6]!.t], [[...fromHex('#ff8000')!], 0.71], 'ten steps took it past the stop at 0.625');
    validGradient(now, 'after the keys');

    // ---- Escape during a drag gives the gradient back ----
    await apart();
    const before = await stops();
    const steps = (await past(app)).length;
    await drag(app, stopAt(6), along(0.71), along(0.9), {}, false);
    assert.notEqual(JSON.stringify(await stops()), JSON.stringify(before));
    await key(app, 'Escape');
    await app.eval(`void inspectorTest.up(${quote(stopAt(6))}, ${quote(along(0.9))})`);
    assert.ok(JSON.stringify(await stops()) === JSON.stringify(before), 'the gradient is as it was before the drag');
    assert.deepEqual([(await past(app)).length, await app.eval<number>(`orogenTest.ctx.doc.getState().future.length`)], [steps, 0], 'nothing to undo and nothing to redo');

    // ---- a stop dragged well away from the bar is removed, in one entry; Delete removes the focused one ----
    await apart();
    await drag(app, stopAt(6), along(0.71), { x: along(0.71).x, y: along(0.71).y + 80 });
    now = await stops();
    assert.equal(now.length, 9);
    assert.ok(now.every((stop) => toHex(stop.color) !== '#ff8000'), 'the orange stop is gone');
    assert.equal((await past(app)).length, steps + 1);
    await app.eval(`void shellTest.focus(${quote(stopAt(3))})`);
    await key(app, 'Delete', {}, stopAt(3));
    assert.equal((await stops()).length, 8);
    await press(app, `${editor} [data-action="add-stop"]`);
    assert.equal((await stops()).length, 9);
    await press(app, `${editor} [data-action="remove-stop"]`);
    assert.equal((await stops()).length, 8);

    // ---- reversed, set at equal distances, and replaced by a palette ----
    now = await stops();
    await press(app, `${editor} [data-action="reverse"]`);
    assert.ok(JSON.stringify(await stops()) === JSON.stringify(reverseStops(now)), 'end for end');
    await press(app, `${editor} [data-action="palettes"]`);
    await appears(app, '[data-ui="menu"] [data-item="alpine"]');
    assert.equal(await count(app, '[data-ui="menu"] [data-item]'), PALETTES.length + 1);
    await press(app, '[data-ui="menu"] [data-item="distribute"]');
    await vanishes(app, '[data-ui="menu"]');
    assert.ok(JSON.stringify(await stops()) === JSON.stringify(distributeStops(reverseStops(now))), 'at equal distances');
    await press(app, `${editor} [data-action="palettes"]`);
    await appears(app, '[data-ui="menu"] [data-item="alpine"]');
    await press(app, '[data-ui="menu"] [data-item="alpine"]');
    await vanishes(app, '[data-ui="menu"]');
    const alpine = PALETTES.find((palette) => palette.id === 'alpine')!.stops;
    assert.ok(JSON.stringify(await stops()) === JSON.stringify(alpine), 'the document holds the palette');
    assert.equal(await count(app, `${editor} [data-stop]`), alpine.length);
    await settled(app);
    await painted(alpine, 'the palette');
    t.diagnostic(`capture: ${await capture(app, 'gradient-palette')}`);

    // ---- the reset of the row ----
    await press(app, `${row('gradient')} [data-action="reset"]`);
    assert.ok(JSON.stringify(await stops()) === JSON.stringify(start), 'the node\'s default gradient');
    assert.equal((await past(app)).at(-1)!.label, 'Gradient Map: Reset Gradient');
    await app.waitFor(`orogenTest.ctx.engineState.getState().keys[${quote(ids.gradient)}] === ${quote(key0)}`, PAGE_BACKSTOP_MS);
    assert.equal(await count(app, `${PANEL} [data-param][data-changed]`), 0);
  });
});
