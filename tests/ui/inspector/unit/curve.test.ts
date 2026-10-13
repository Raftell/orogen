// Editing a curve as pure functions (src/app/panels/inspector/curve.ts): whatever is done to it, the result is a
// curve as engine.md 4.3 defines one, and the picture is evalCurve's.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evalCurve, type CurvePoint } from '../../../../src/core/api.ts';
import { nodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry, normalizeParams } from '../../../../src/core/runtime.ts';
import {
  addPoint, CURVE_GAP, CURVE_MAX_POINTS, CURVE_PRESETS, CURVE_SNAP, curvePath, hitPoint, movePoint, removePoint, sampleCurve, widestGap, xLimits,
} from '../../../../src/app/panels/inspector/curve.ts';

const CURVE = createRegistry(nodes).get('adjust/curve')!;
const LINE: readonly CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const S: readonly CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.3, y: 0.06 }, { x: 0.7, y: 0.94 }, { x: 1, y: 1 }];

/** A curve as the document accepts it: normalizeParams changes nothing of it. */
function valid(points: readonly CurvePoint[], what: string): void {
  assert.ok(points.length >= 2, `${what}: ${points.length} points`);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `${what}: point ${i} is in the unit square`);
    if (i > 0) assert.ok(p.x > points[i - 1]!.x, `${what}: x increases strictly at point ${i}`);
  }
  assert.deepEqual(normalizeParams(CURVE, { curve: points }).problems, [], what);
}

test('a point is added where the pointer is, between its neighbours, or on the curve when no height is given', () => {
  const made = addPoint(S, 0.5, 0.8)!;
  assert.deepEqual([made.index, made.points.length, made.points[2]], [2, 5, { x: 0.5, y: 0.8 }]);
  valid(made.points, 'a point in the middle');
  assert.equal(S.length, 4, 'the curve it was added to is as it was');

  const on = addPoint(S, 0.5)!;
  assert.equal(on.points[on.index]!.y, Number(evalCurve(S, 0.5).toFixed(4)), 'without a height the point lies on the curve');
  // On a straight line such a point changes nothing of the picture.
  const straight = addPoint(LINE, 0.4)!;
  for (const x of [0, 0.2, 0.4, 0.7, 1]) assert.ok(Math.abs(evalCurve(straight.points, x) - x) < 1e-9, `the line at ${x}`);

  // Before the first and behind the last point.
  const inner: readonly CurvePoint[] = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }];
  assert.equal(addPoint(inner, 0.05, 0.5)!.index, 0);
  assert.equal(addPoint(inner, 0.95, 0.5)!.index, 2);
  valid(addPoint(inner, 0.05, 0.5)!.points, 'before the first');

  // On the x of a point there is no room: the new one goes beside it.
  const beside = addPoint(S, 0.3, 0.5)!;
  assert.deepEqual([beside.index, beside.points[beside.index]!.x], [2, 0.3 + CURVE_GAP]);
  valid(beside.points, 'beside a point');
  // Values outside the square are taken into it.
  assert.deepEqual(addPoint(inner, 7, -3)!.points[2], { x: 1, y: 0 });
});

test('a curve takes no point where there is no room, and none beyond its limit', () => {
  const tight: readonly CurvePoint[] = [{ x: 0.5, y: 0 }, { x: 0.5 + CURVE_GAP, y: 1 }];
  assert.equal(addPoint(tight, 0.5005, 0.5), null, 'between two points one gap apart');
  assert.equal(addPoint([{ x: 0, y: 0 }, { x: 0.0005, y: 0.5 }, { x: 1, y: 1 }], 0.0002, 0.2), null);
  let full: readonly CurvePoint[] = LINE;
  for (let i = 0; i < CURVE_MAX_POINTS + 8; i++) full = addPoint(full, widestGap(full))?.points ?? full;
  assert.equal(full.length, CURVE_MAX_POINTS);
  assert.equal(addPoint(full, 0.123), null);
  valid(full, 'a full curve');
});

test('a point moves between its neighbours and stays in the unit square', () => {
  const moved = movePoint(S, 1, 0.5, 0.4);
  assert.deepEqual(moved[1], { x: 0.5, y: 0.4 });
  assert.equal(moved[2], S[2], 'the other points are the same objects');
  valid(moved, 'moved');

  // Past a neighbour it stops one gap before it, on either side.
  assert.equal(movePoint(S, 1, 0.9, 0.5)[1]!.x, 0.7 - CURVE_GAP);
  assert.equal(movePoint(S, 2, 0.1, 0.5)[2]!.x, 0.3 + CURVE_GAP);
  valid(movePoint(S, 1, 0.9, 0.5), 'held before the next point');
  // The ends move freely as far as the square goes.
  assert.deepEqual(movePoint(S, 0, -1, 2)[0], { x: 0, y: 1 });
  assert.deepEqual(movePoint(S, 3, 9, -9)[3], { x: 1, y: 0 });
  assert.equal(movePoint(S, 0, 0.2, 0)[0]!.x, 0.2, 'the first point need not lie at 0');
  assert.deepEqual([xLimits(S, 0), xLimits(S, 1), xLimits(S, 3)], [{ lo: 0, hi: 0.299 }, { lo: 0.001, hi: 0.699 }, { lo: 0.701, hi: 1 }]);

  // Snapped to sixteenths.
  assert.deepEqual(movePoint(S, 1, 0.33, 0.21, CURVE_SNAP)[1], { x: 0.3125, y: 0.1875 });
  // A move that changes nothing returns the list it was given.
  assert.equal(movePoint(S, 1, 0.3, 0.06), S);
  assert.equal(movePoint(S, 9, 0.5, 0.5), S, 'no such point');
  // Values that are no numbers do no harm.
  valid(movePoint(S, 1, Number.NaN, Number.POSITIVE_INFINITY), 'not finite');
});

test('a point is removed, and a curve keeps two', () => {
  const fewer = removePoint(S, 1);
  assert.deepEqual(fewer, [S[0], S[2], S[3]]);
  valid(fewer, 'three points');
  assert.equal(removePoint(LINE, 0), LINE, 'two points stay');
  assert.equal(removePoint(S, -1), S);
  assert.equal(removePoint(S, 4), S);
});

test('the picture is evalCurve: it passes through every point and never leaves the range of its neighbours', () => {
  const samples = sampleCurve(S, 65);
  assert.ok(samples.length >= 65 && samples.length <= 65 + S.length);
  for (const sample of samples) assert.equal(sample.y, evalCurve(S, sample.x), `the sample at ${sample.x}`);
  for (const point of S) assert.ok(samples.some((sample) => sample.x === point.x && Math.abs(sample.y - point.y) < 1e-12), `a sample at the point x = ${point.x}`);
  assert.deepEqual([samples[0]!.x, samples[samples.length - 1]!.x], [0, 1]);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i]!.x > samples[i - 1]!.x, 'the samples go from left to right');
  // Monotone as the contract defines the interpolant: rising points give a curve that never falls.
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i]!.y >= samples[i - 1]!.y - 1e-12, `no dip before ${samples[i]!.x}`);

  // Outside its points a curve is level.
  const inner: readonly CurvePoint[] = [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.9 }];
  const flat = sampleCurve(inner, 9);
  assert.deepEqual([flat[0], flat[flat.length - 1]], [{ x: 0, y: 0.2 }, { x: 1, y: 0.9 }]);

  // The path draws x to the right and y upwards: (0, 0) is the bottom left of the plot.
  const path = curvePath(LINE, 200, 100, 3);
  assert.equal(path, 'M0 100L100 50L200 0');
  assert.match(curvePath(S, 240, 148), /^M0 148(L[\d.]+ [\d.]+)+$/);
});

test('a press takes the nearest point within reach', () => {
  // The plot is 200 by 100 pixels; the point (0.3, 0.06) lies at 60, 94 from the bottom left.
  assert.equal(hitPoint(S, 0.3, 0.06, 200, 100, 8), 1);
  assert.equal(hitPoint(S, 0.3 + 5 / 200, 0.06 + 5 / 100, 200, 100, 8), 1, 'five pixels away in both directions');
  assert.equal(hitPoint(S, 0.3 + 9 / 200, 0.06, 200, 100, 8), -1, 'nine pixels away');
  assert.equal(hitPoint(S, 0.5, 0.5, 200, 100, 8), -1);
  const close: readonly CurvePoint[] = [{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 }];
  assert.equal(hitPoint(close, 0.515, 0.5, 200, 100, 8), 1, 'of two within reach, the nearer');
});

test('a point added by the button goes into the widest gap', () => {
  assert.equal(widestGap(LINE), 0.5);
  assert.equal(widestGap(S), 0.5);
  assert.equal(widestGap([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.9, y: 1 }, { x: 1, y: 1 }]), 0.5);
  assert.equal(widestGap([{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 1, y: 1 }]), 0.3);
});

test('every preset is a curve the document takes as it is', () => {
  assert.ok(CURVE_PRESETS.length >= 6);
  assert.equal(new Set(CURVE_PRESETS.map((preset) => preset.id)).size, CURVE_PRESETS.length);
  for (const preset of CURVE_PRESETS) {
    valid(preset.points, preset.label);
    assert.match(preset.label, /^[A-Z][a-z-]*( [a-z]+)*$/, `"${preset.label}" is sentence case`);
  }
  const linear = CURVE_PRESETS.find((preset) => preset.id === 'linear')!;
  for (const x of [0, 0.3, 1]) assert.equal(evalCurve(linear.points, x), x);
  const inverted = CURVE_PRESETS.find((preset) => preset.id === 'inverted')!;
  assert.deepEqual([evalCurve(inverted.points, 0), evalCurve(inverted.points, 1)], [1, 0]);
});

test('a long run of edits leaves a curve', () => {
  // A fixed sequence of pseudo-random edits; the bound is the loop's.
  let state = 12345;
  const random = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  let points: readonly CurvePoint[] = S;
  for (let step = 0; step < 400; step++) {
    const pick = random();
    const index = Math.floor(random() * points.length);
    if (pick < 0.3) points = addPoint(points, random() * 1.2 - 0.1, random() * 1.2 - 0.1)?.points ?? points;
    else if (pick < 0.5) points = removePoint(points, index);
    else points = movePoint(points, index, random() * 1.4 - 0.2, random() * 1.4 - 0.2, pick > 0.9 ? CURVE_SNAP : 0);
    valid(points, `after step ${step}`);
  }
});
