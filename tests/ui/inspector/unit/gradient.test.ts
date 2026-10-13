// Editing a gradient as pure functions (src/app/panels/inspector/gradient.ts): whatever is done to it, the result
// is a gradient as engine.md 4.3 defines one, and its picture is bakeGradient's.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bakeGradient, type GradientStop } from '../../../../src/core/api.ts';
import { nodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry, normalizeParams } from '../../../../src/core/runtime.ts';
import { fromHex, linearToSrgb, toHex } from '../../../../src/app/ui/color.ts';
import {
  addStop, colorAt, distributeStops, GRADIENT_MAX_STOPS, gradientPixels, moveStop, PALETTES, removeStop, reverseStops, setStopColor,
} from '../../../../src/app/panels/inspector/gradient.ts';

const GRADIENT_MAP = createRegistry(nodes).get('color/gradient-map')!;
const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];
const RED: [number, number, number] = [1, 0, 0];
const RAMP: readonly GradientStop[] = [{ t: 0, color: BLACK }, { t: 1, color: WHITE }];
const THREE: readonly GradientStop[] = [{ t: 0, color: BLACK }, { t: 0.5, color: RED }, { t: 1, color: WHITE }];

/** A gradient as the document accepts it: normalizeParams changes nothing of it. */
function valid(stops: readonly GradientStop[], what: string): void {
  assert.ok(stops.length >= 2, `${what}: ${stops.length} stops`);
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]!;
    assert.ok(stop.t >= 0 && stop.t <= 1 && stop.color.length === 3 && stop.color.every((c) => c >= 0 && c <= 1), `${what}: stop ${i} is in range`);
    if (i > 0) assert.ok(stop.t >= stops[i - 1]!.t, `${what}: the positions do not fall at stop ${i}`);
  }
  assert.deepEqual(normalizeParams(GRADIENT_MAP, { gradient: stops }).problems, [], what);
}

test('the color at a place is the one a kernel reads there', () => {
  assert.deepEqual(colorAt(RAMP, 0), BLACK);
  assert.deepEqual(colorAt(RAMP, 1), WHITE);
  assert.deepEqual(colorAt(RAMP, 0.25), [0.25, 0.25, 0.25], 'a straight line between the stops, in linear RGB');
  assert.deepEqual(colorAt(THREE, 0.25), [0.5, 0, 0]);
  assert.deepEqual(colorAt(THREE, 0.75), [1, 0.5, 0.5]);
  assert.deepEqual([colorAt(RAMP, -3), colorAt(RAMP, 9)], [BLACK, WHITE], 'level outside 0..1');
  // The table kernels read has 256 entries: the color at one of them is that entry.
  const table = bakeGradient(THREE, 256);
  const at = colorAt(THREE, 100 / 255);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(at[c]! - table[100 * 4 + c]!) < 1e-6, `channel ${c}`);
});

test('a stop is added with the gradient\'s own color, which leaves the picture as it was', () => {
  const made = addStop(RAMP, 0.4)!;
  assert.deepEqual([made.index, made.stops.length, made.stops[1]], [1, 3, { t: 0.4, color: [0.4, 0.4, 0.4] }]);
  valid(made.stops, 'a stop in the middle');
  const before = bakeGradient(RAMP, 64);
  const after = bakeGradient(made.stops, 64);
  for (let i = 0; i < before.length; i++) assert.ok(Math.abs(before[i]! - after[i]!) < 1e-6, `sample ${i}`);
  assert.equal(RAMP.length, 2, 'the gradient it was added to is as it was');

  assert.deepEqual(addStop(RAMP, 0.4, RED)!.stops[1], { t: 0.4, color: RED }, 'or with a color given');
  // At the place of a stop the new one goes behind it; outside 0..1 it goes to the end.
  assert.equal(addStop(THREE, 0.5)!.index, 2);
  assert.deepEqual([addStop(RAMP, -1)!.index, addStop(RAMP, 2)!.index, addStop(RAMP, 2)!.stops[2]!.t], [1, 2, 1]);
  valid(addStop(THREE, 0.5)!.stops, 'two stops at one place');

  let full: readonly GradientStop[] = RAMP;
  for (let i = 0; i < GRADIENT_MAX_STOPS + 5; i++) full = addStop(full, (i * 0.37) % 1)?.stops ?? full;
  assert.equal(full.length, GRADIENT_MAX_STOPS);
  assert.equal(addStop(full, 0.5), null);
  valid(full, 'a full gradient');
});

test('a stop that is dragged past another changes its place in the list, and the edit says where it is', () => {
  const right = moveStop(THREE, 0, 0.7);
  assert.deepEqual([right.index, right.stops.map((stop) => stop.t)], [1, [0.5, 0.7, 1]]);
  assert.deepEqual(right.stops[1]!.color, BLACK, 'it is the stop that was dragged');
  valid(right.stops, 'dragged to the right');

  const left = moveStop(THREE, 2, 0.2);
  assert.deepEqual([left.index, left.stops.map((stop) => stop.t), left.stops[1]!.color], [1, [0, 0.2, 0.5], WHITE]);
  valid(left.stops, 'dragged to the left');

  // Onto the place of another stop: behind it coming from the left, before it coming from the right.
  assert.equal(moveStop(THREE, 0, 0.5).index, 1);
  assert.equal(moveStop(THREE, 2, 0.5).index, 1);
  valid(moveStop(THREE, 0, 0.5).stops, 'onto another stop');
  // Held in 0..1.
  assert.deepEqual([moveStop(THREE, 1, -4).stops[0]!.t, moveStop(THREE, 1, 4).stops[2]!.t], [0, 1]);
  assert.deepEqual([moveStop(THREE, 1, -4).index, moveStop(THREE, 1, 4).index], [0, 2]);
  // A move that changes nothing returns the list it was given.
  assert.equal(moveStop(THREE, 1, 0.5).stops, THREE);
  assert.deepEqual(moveStop(THREE, 7, 0.5), { stops: THREE, index: 7 });
  // A drag in steps follows one stop all the way across.
  let edit = { stops: THREE, index: 0 };
  for (let step = 1; step <= 20; step++) {
    edit = moveStop(edit.stops, edit.index, step / 20);
    assert.deepEqual(edit.stops[edit.index]!.color, BLACK, `step ${step}`);
    valid(edit.stops, `step ${step}`);
  }
  assert.deepEqual([edit.index, edit.stops[2]!.t], [2, 1]);
});

test('a stop is removed and recolored; a gradient keeps two stops', () => {
  assert.deepEqual(removeStop(THREE, 1), RAMP);
  assert.equal(removeStop(RAMP, 0), RAMP);
  assert.equal(removeStop(THREE, 5), THREE);

  const blue = setStopColor(THREE, 1, [0, 0, 1]);
  assert.deepEqual(blue.map((stop) => stop.color), [BLACK, [0, 0, 1], WHITE]);
  assert.equal(blue[0], THREE[0], 'the other stops are the same objects');
  assert.equal(setStopColor(THREE, 1, RED), THREE, 'the same color changes nothing');
  assert.deepEqual(setStopColor(THREE, 1, [2, -1, 0.1234567])[1]!.color, [1, 0, 0.123457], 'held in 0..1, six decimals');
  valid(blue, 'recolored');
});

test('a gradient is reversed end for end and its stops are set at equal distances', () => {
  const uneven: readonly GradientStop[] = [{ t: 0, color: BLACK }, { t: 0.2, color: RED }, { t: 1, color: WHITE }];
  const reversed = reverseStops(uneven);
  assert.deepEqual(reversed, [{ t: 0, color: WHITE }, { t: 0.8, color: RED }, { t: 1, color: BLACK }]);
  valid(reversed, 'reversed');
  assert.deepEqual(reverseStops(reversed), uneven, 'twice is the gradient itself');
  for (const t of [0, 0.1, 0.5, 0.9, 1]) assert.deepEqual(colorAt(reversed, t), colorAt(uneven, 1 - t), `the color at ${t}`);

  assert.deepEqual(distributeStops(uneven).map((stop) => stop.t), [0, 0.5, 1]);
  assert.deepEqual(distributeStops(uneven).map((stop) => stop.color), [BLACK, RED, WHITE]);
  valid(distributeStops(uneven), 'distributed');
});

test('the strip is bakeGradient in the colors of a screen', () => {
  const pixels = gradientPixels(THREE, 5);
  assert.equal(pixels.length, 20);
  const table = bakeGradient(THREE, 5);
  for (let i = 0; i < 5; i++) {
    for (let c = 0; c < 3; c++) assert.equal(pixels[i * 4 + c], Math.round(linearToSrgb(table[i * 4 + c]!) * 255), `pixel ${i}, channel ${c}`);
    assert.equal(pixels[i * 4 + 3], 255);
  }
  // Half way between black and red in linear light is sRGB 188, not 128: the strip is not a CSS gradient.
  assert.deepEqual([...pixels.slice(4, 8)], [188, 0, 0, 255]);
  assert.equal(gradientPixels(RAMP, 256).length, 1024);
  assert.equal(gradientPixels(RAMP, 0).length, 4, 'never less than one pixel');
});

test('the palettes are gradients the document takes as they are, from the lowest ground to the highest', () => {
  assert.ok(PALETTES.length >= 8, `${PALETTES.length} palettes`);
  assert.equal(new Set(PALETTES.map((palette) => palette.id)).size, PALETTES.length);
  for (const palette of PALETTES) {
    valid(palette.stops, palette.label);
    assert.deepEqual([palette.stops[0]!.t, palette.stops[palette.stops.length - 1]!.t], [0, 1], `${palette.label} spans the gradient`);
    assert.match(palette.label, /^[A-Z][a-z]+$/, `"${palette.label}" is one capitalised word`);
    for (const stop of palette.stops) assert.deepEqual(fromHex(toHex(stop.color)), stop.color, `${palette.label}: a stop is a color of 8 bits per channel`);
  }
  const grayscale = PALETTES.find((palette) => palette.id === 'grayscale')!;
  assert.deepEqual(grayscale.stops, RAMP);
});
