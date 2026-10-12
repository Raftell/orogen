// evalCurve, bakeCurve and bakeGradient (engine.md 4.9) against values computed by hand.
//
// The curve is the Fritsch-Carlson monotone cubic: with secants d_k, tangents m_k = (d_(k-1) + d_k) / 2 inside,
// the one secant at an end, 0 where the secants differ in sign or one is 0; per interval with a = m_k / d_k,
// b = m_(k+1) / d_k and a² + b² > 9 both tangents are scaled by 3 / sqrt(a² + b²). On an interval of width h,
// with t = (x - x_k) / h:
//   y = y_k (2t³ - 3t² + 1) + h m_k (t³ - 2t² + t) + y_(k+1) (3t² - 2t³) + h m_(k+1) (t³ - t²)
// At t = 1/2 the four weights are 1/2, 1/8, 1/2 and -1/8.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeCurve, bakeGradient, evalCurve, type CurvePoint, type GradientStop } from '../../src/core/api.ts';

const close = (actual: number, expected: number, tolerance = 1e-12): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
};

test('two points are a straight line, constant outside them', () => {
  const line: CurvePoint[] = [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.8 }];
  close(evalCurve(line, 0.25), 0.2);
  close(evalCurve(line, 0.5), 0.5);
  close(evalCurve(line, 0.375), 0.35);
  close(evalCurve(line, 0.75), 0.8);
  assert.equal(evalCurve(line, 0), 0.2);
  assert.equal(evalCurve(line, -5), 0.2);
  assert.equal(evalCurve(line, 1), 0.8);
  assert.equal(evalCurve(line, 9), 0.8);
});

test('collinear points stay a straight line', () => {
  const line: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
  for (const x of [0, 0.1, 0.3, 0.5, 0.77, 1]) close(evalCurve(line, x), x);
});

test('the curve passes through its points', () => {
  const points: CurvePoint[] = [{ x: 0, y: 0.1 }, { x: 0.2, y: 0.9 }, { x: 0.6, y: 0.3 }, { x: 1, y: 0.35 }];
  for (const p of points) close(evalCurve(points, p.x), p.y);
});

test('a flat interval stays flat and its ends have tangent zero', () => {
  // Secants 1, 0, 2. Tangents: m0 = 1, m1 = m2 = 0 (a secant is 0), m3 = 2. No interval is limited.
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.5 }, { x: 1, y: 1 }];
  // x = 0.25: h = 0.5, t = 1/2:  0 + 0.5 * 1 / 8 + 0.5 / 2 + 0 = 0.3125
  close(evalCurve(points, 0.25), 0.3125);
  for (const x of [0.5, 0.55, 0.625, 0.7, 0.75]) close(evalCurve(points, x), 0.5);
  // x = 0.875: h = 0.25, t = 1/2:  0.5 / 2 + 0 + 1 / 2 - 0.25 * 2 / 8 = 0.6875
  close(evalCurve(points, 0.875), 0.6875);
});

test('tangents that would overshoot are limited to the circle of radius 3', () => {
  // Secants d0 = 3, d1 = 1/3. Tangents m0 = 3, m1 = 5/3, m2 = 1/3.
  // Interval 0: a = 1, b = 5/9, a² + b² < 9: unchanged.
  // Interval 1: a = 5, b = 1, a² + b² = 26 > 9: m1 = 3/sqrt(26) * 5 * 1/3 = 5/sqrt(26), m2 = 1/sqrt(26).
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.25, y: 0.75 }, { x: 1, y: 1 }];
  const r = Math.sqrt(26);
  // x = 0.125: h = 0.25, t = 1/2:  0 + 0.25 * 3 / 8 + 0.75 / 2 - 0.25 * (5/r) / 8
  close(evalCurve(points, 0.125), 0.09375 + 0.375 - 0.15625 / r);
  // x = 0.625: h = 0.75, t = 1/2:  0.75 / 2 + 0.75 * (5/r) / 8 + 1 / 2 - 0.75 * (1/r) / 8
  close(evalCurve(points, 0.625), 0.875 + 0.375 / r);
  // x = 0.4375: h = 0.75, t = 1/4: weights 27/32, 9/64, 5/32, -3/64
  close(evalCurve(points, 0.4375), 0.75 * 27 / 32 + 0.75 * (5 / r) * 9 / 64 + 5 / 32 - 0.75 * (1 / r) * 3 / 64);
});

test('the interpolant of monotone points is monotone and stays within them', () => {
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.1, y: 0.02 }, { x: 0.15, y: 0.9 }, { x: 0.6, y: 0.91 }, { x: 1, y: 1 }];
  let previous = -Infinity;
  for (let i = 0; i <= 2000; i++) {
    const y = evalCurve(points, i / 2000);
    assert.ok(y >= previous - 1e-12, `not monotone at ${i / 2000}`);
    assert.ok(y >= 0 && y <= 1);
    previous = y;
  }
});

test('a local extremum of the points has tangent zero, so the curve does not exceed it', () => {
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }];
  // Secants 2 and -2: m1 = 0, m0 = 2, m2 = -2. x = 0.25: h = 0.5, t = 1/2:  0 + 0.5 * 2 / 8 + 1 / 2 - 0 = 0.625
  close(evalCurve(points, 0.25), 0.625);
  close(evalCurve(points, 0.75), 0.625);
  for (let i = 0; i <= 200; i++) assert.ok(evalCurve(points, i / 200) <= 1);
});

test('the tangent at an extremum is zero whatever the two secants are', () => {
  // Secants 4 and -1: their mean is 1.5, but they differ in sign, so m1 = 0. m0 = 4, m2 = -1.
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.25, y: 1 }, { x: 1, y: 0.25 }];
  // x = 0.125: h = 0.25, t = 1/2:  0 + 0.25 * 4 / 8 + 1 / 2 - 0 = 0.625
  close(evalCurve(points, 0.125), 0.625);
  // x = 0.625: h = 0.75, t = 1/2:  1 / 2 + 0 + 0.25 / 2 - 0.75 * (-1) / 8 = 0.71875
  close(evalCurve(points, 0.625), 0.71875);
  for (let i = 0; i <= 400; i++) assert.ok(evalCurve(points, i / 400) <= 1);
});

test('degenerate curves have a value', () => {
  assert.equal(evalCurve([], 0.5), 0);
  assert.equal(evalCurve([{ x: 0.3, y: 0.7 }], 0), 0.7);
  assert.equal(evalCurve([{ x: 0.3, y: 0.7 }], 1), 0.7);
  assert.equal(evalCurve([{ x: 0, y: 0.25 }, { x: 1, y: 1 }], NaN), 0.25);
});

test('a point that does not advance in x is left out, so no sample is NaN', () => {
  const valid: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }];
  const stalled: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.9 }, { x: 0.25, y: 0.7 }, { x: 1, y: 1 }, { x: NaN, y: 0 }];
  for (const x of [0, 0.25, 0.5, 0.75, 1]) assert.equal(evalCurve(stalled, x), evalCurve(valid, x));
  for (const y of bakeCurve(stalled, 33)) assert.ok(Number.isFinite(y));
  assert.equal(evalCurve([{ x: 0.5, y: 0.25 }, { x: 0.5, y: 0.75 }], 0.5), 0.25);
});

test('bakeCurve: sample i is evalCurve(points, i / (n - 1)), 1024 samples by default', () => {
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.25, y: 0.75 }, { x: 1, y: 1 }];
  const lut = bakeCurve(points);
  assert.ok(lut instanceof Float32Array);
  assert.equal(lut.length, 1024);
  for (const i of [0, 1, 127, 255, 256, 640, 1023]) assert.equal(lut[i], Math.fround(evalCurve(points, i / 1023)));
  assert.equal(lut[0], 0);
  assert.equal(lut[1023], 1);

  const five = bakeCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], 5);
  assert.deepEqual(Array.from(five), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(Array.from(bakeCurve([{ x: 0, y: 0.25 }, { x: 1, y: 1 }], 1)), [0.25]);
  assert.throws(() => bakeCurve(points, 0), RangeError);
  assert.throws(() => bakeCurve(points, 2.5), RangeError);
});

test('bakeGradient: linear in linear RGB between neighbouring stops, alpha 1', () => {
  const stops: GradientStop[] = [{ t: 0, color: [0, 0, 0] }, { t: 0.5, color: [1, 0, 0] }, { t: 1, color: [1, 1, 1] }];
  assert.deepEqual(Array.from(bakeGradient(stops, 5)), [
    0, 0, 0, 1,
    0.5, 0, 0, 1,
    1, 0, 0, 1,
    1, 0.5, 0.5, 1,
    1, 1, 1, 1,
  ]);
  const lut = bakeGradient(stops);
  assert.equal(lut.length, 256 * 4);
  // Sample 51 is at t = 0.2: 0.4 of the way from black to red.
  assert.deepEqual(Array.from(lut.subarray(51 * 4, 52 * 4)), [Math.fround(0.4), 0, 0, 1]);
  // Sample 204 is at t = 0.8: 0.6 of the way from red to white.
  assert.deepEqual(Array.from(lut.subarray(204 * 4, 205 * 4)), [1, Math.fround(0.6), Math.fround(0.6), 1]);
});

test('bakeGradient: constant before the first and after the last stop', () => {
  const stops: GradientStop[] = [{ t: 0.25, color: [0.2, 0.4, 0.6] }, { t: 0.75, color: [0.6, 0.4, 0.2] }];
  const lut = bakeGradient(stops, 9);
  const at = (i: number): number[] => Array.from(lut.subarray(i * 4, i * 4 + 4));
  const f = Math.fround;
  assert.deepEqual(at(0), [f(0.2), f(0.4), f(0.6), 1]);
  assert.deepEqual(at(1), [f(0.2), f(0.4), f(0.6), 1]);
  assert.deepEqual(at(2), [f(0.2), f(0.4), f(0.6), 1]);        // t = 0.25, the first stop
  assert.deepEqual(at(4), [f(0.4), f(0.4), f(0.4), 1]);        // t = 0.5, halfway
  assert.deepEqual(at(6), [f(0.6), f(0.4), f(0.2), 1]);        // t = 0.75, the last stop
  assert.deepEqual(at(8), [f(0.6), f(0.4), f(0.2), 1]);
});

test('bakeGradient: two stops at one t are a hard edge, the later one from that t on', () => {
  const stops: GradientStop[] = [
    { t: 0, color: [0, 0, 0] }, { t: 0.5, color: [0.5, 0.5, 0.5] }, { t: 0.5, color: [1, 0, 0] }, { t: 1, color: [1, 0, 0] },
  ];
  const lut = bakeGradient(stops, 5);
  assert.deepEqual(Array.from(lut), [
    0, 0, 0, 1,
    0.25, 0.25, 0.25, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
  ]);
  assert.throws(() => bakeGradient(stops, 0), RangeError);
});
