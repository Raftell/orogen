// tests/nodes/select/curvature.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/curvature.ts';

conformance(def);

// With the test settings the terrain is 4096 m wide and a height of 1 is 1024 m.
const TERRAIN = 4096, RANGE = 1024;
/** The node's gain: a bend of 0.2 is fully selected at a strength of 0.5, and the strength acts as its cube. */
const gain = (strength: number): number => (2 * strength) ** 3 / 0.2;

/** The paraboloid k * ((u - 0.5)^2 + (v - 0.5)^2): a bowl for k above 0, a dome below. */
const paraboloid = (res: number, k: number): FieldData => fieldOf(res, (u, v) => k * ((u - 0.5) ** 2 + (v - 0.5) ** 2));

/**
 * The mean curvature of that paraboloid as a surface in metres, z = a r^2 with a = k * RANGE / TERRAIN^2, at the
 * distance r from its axis: half the sum of the curvature along the meridian, 2a / (1 + 4 a^2 r^2)^(3/2), and
 * of the one around the axis, 2a / (1 + 4 a^2 r^2)^(1/2).
 */
function meanCurvature(k: number, u: number, v: number): number {
  const a = (k * RANGE) / TERRAIN ** 2;
  const steep = 1 + 4 * a * a * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * TERRAIN ** 2;
  return a / steep ** 1.5 + a / steep ** 0.5;
}

test('select/curvature: on a paraboloid the mask is its mean curvature times the radius, up to the border', async () => {
  // A bowl whose rim is at 45 degrees in the corners. A radius of 0.01 is fitted in one pass at 257 (2.56 texels);
  // 0.06 is 15.4 texels, fitted on a coarser grid.
  for (const [radius, tolerance] of [[0.01, 1e-4], [0.06, 2e-3]] as const) {
    const expected = fieldOf(257, (u, v) => Math.min(1, meanCurvature(4, u, v) * radius * TERRAIN * gain(0.5)));
    const hollow = await renderNode(def, { inputs: { in: paraboloid(257, 4) }, params: { mode: 'concave', radius } });
    expectClose(hollow.out, expected, { max: tolerance });
    assert.ok(stats(expected).max - stats(expected).min > 0.01, 'the curvature falls from the centre to the rim, and the mask with it');
    // The dome is the same ground upside down: convex where the bowl is concave.
    const dome = await renderNode(def, { inputs: { in: paraboloid(257, -4) }, params: { mode: 'convex', radius } });
    expectClose(dome.out, expected, { max: tolerance });
    const both = await renderNode(def, { inputs: { in: paraboloid(257, -4) }, params: { mode: 'both', radius } });
    expectClose(both.out, expected, { max: tolerance });
    // Neither has ground of the other kind.
    expectStats((await renderNode(def, { inputs: { in: paraboloid(257, 4) }, params: { mode: 'convex', radius } })).out, { max: [0, 0] });
    expectStats((await renderNode(def, { inputs: { in: paraboloid(257, -4) }, params: { mode: 'concave', radius } })).out, { max: [0, 0] });
  }
});

test('select/curvature: a plane has no curvature, however steep and up to its border', async () => {
  const rise = 4 * Math.tan((50 * Math.PI) / 180);
  const plane = fieldOf(257, (u, v) => rise * (0.4 * u + 0.9 * v));
  for (const radius of [0.0001, 0.005, 0.06]) {
    for (const mode of ['convex', 'concave', 'both'] as const) {
      // Full strength: 40 times the bend. What is left is the rounding of a height near 4 in float32.
      expectStats((await renderNode(def, { inputs: { in: plane }, params: { mode, radius, strength: 1 } })).out, { max: [0, 2e-3] });
    }
  }
});

test('select/curvature: the crest of a ridge is convex and its trough concave, by the bend the Gaussian of the radius leaves', async () => {
  // Ridges 0.25 apart and 0.02 high, with a crest at u = 0.5 and troughs at 0.375 and 0.625. On a crest the
  // ground is level and its mean curvature is half its second derivative, A k^2 in units of the terrain, which
  // a Gaussian of standard deviation r leaves exp(-k^2 r^2 / 2) of.
  const amplitude = 0.02, k = (2 * Math.PI) / 0.25, radius = 0.02;
  const ridges = fieldOf(257, (u) => 0.5 + amplitude * Math.cos(k * (u - 0.5)));
  const bend = 0.5 * amplitude * (RANGE / TERRAIN) * k * k * radius * Math.exp(-(k * k * radius * radius) / 2);
  const expected = bend * gain(0.5);
  assert.ok(expected > 0.1 && expected < 0.2);
  const convex = (await renderNode(def, { inputs: { in: ridges }, params: { radius } })).out;
  const concave = (await renderNode(def, { inputs: { in: ridges }, params: { radius, mode: 'concave' } })).out;
  const both = (await renderNode(def, { inputs: { in: ridges }, params: { radius, mode: 'both' } })).out;
  for (const y of [0, 77, 256]) {
    assert.ok(Math.abs(at(convex, 128, y) / expected - 1) <= 0.005, `row ${y}: the crest is ${at(convex, 128, y)}; expected ${expected}`);
    assert.ok(Math.abs(at(concave, 96, y) / expected - 1) <= 0.005, `row ${y}: the trough is ${at(concave, 96, y)}; expected ${expected}`);
    assert.equal(at(convex, 96, y), 0, 'a trough is not convex');
    assert.equal(at(concave, 128, y), 0, 'a crest is not concave');
    assert.ok(Math.abs(at(both, 128, y) - at(convex, 128, y)) <= 1e-6 && Math.abs(at(both, 160, y) - at(concave, 160, y)) <= 1e-6);
  }
});

test('select/curvature: the radius is the scale: ripples narrower than it do not count', async () => {
  // A broad swell 0.5 long with its top at u = 0.5, carrying ripples 8 texels long: crests at the texels 120,
  // 128 and 136, troughs at 124 and 132.
  const ground = fieldOf(257, (u) => 0.5 + 0.1 * Math.cos(4 * Math.PI * (u - 0.5)) + 0.002 * Math.cos((2 * Math.PI * (u - 0.5) * 256) / 8));
  // At a radius of one texel the ripples are what is measured: their crests are convex, their troughs are not.
  const fine = (await renderNode(def, { inputs: { in: ground }, params: { radius: 0.004 } })).out;
  for (const crest of [120, 128, 136]) assert.ok(at(fine, crest, 50) > 0.15, `the crest of a ripple at ${crest} is ${at(fine, crest, 50)}`);
  for (const trough of [124, 132]) assert.equal(at(fine, trough, 50), 0, `the trough of a ripple at ${trough}`);
  // 0.04 is 10.24 texels: exp(-32) of the ripples is left, and the top of the swell is one smooth crest. Its bend
  // is half of 0.1 (4 pi)^2 / 4, times the radius, times exp(-(4 pi 0.04)^2 / 2).
  const broad = (await renderNode(def, { inputs: { in: ground }, params: { radius: 0.04 } })).out;
  const top = 0.5 * 0.1 * (RANGE / TERRAIN) * (4 * Math.PI) ** 2 * 0.04 * Math.exp(-((4 * Math.PI * 0.04) ** 2) / 2) * gain(0.5);
  assert.ok(Math.abs(at(broad, 128, 50) / top - 1) <= 0.01, `the top of the swell is ${at(broad, 128, 50)}; expected ${top}`);
  // Towards the top the mask rises without a trace of the ripples: by less from one pair of texels to the next.
  let before = Infinity;
  for (const x of [118, 120, 122, 124, 126]) {
    const step = at(broad, x + 2, 50) - at(broad, x, 50);
    assert.ok(step >= 0 && step < before, `from texel ${x} to ${x + 2} the mask changes by ${step}, after ${before}`);
    before = step;
  }
  assert.equal(at(broad, 64, 50), 0, 'the bottom of the swell is not convex');
});

test('select/curvature: a cone is convex at its tip and concave at its foot', async () => {
  const convex = (await renderNode(def, { inputs: { in: 'cone' }, params: { radius: 0.01 } })).out;
  const concave = (await renderNode(def, { inputs: { in: 'cone' }, params: { radius: 0.01, mode: 'concave' } })).out;
  assert.equal(at(convex, 128, 128), 1, 'the tip');
  assert.equal(at(concave, 128, 128), 0, 'the tip is not concave');
  // The foot is the circle of radius 64 texels where the flank meets the floor.
  for (const [x, y] of [[192, 128], [64, 128], [128, 192], [128, 64], [173, 173]] as const) {
    assert.ok(at(concave, x, y) > 0.5, `the foot at (${x}, ${y}) is ${at(concave, x, y)}`);
    assert.equal(at(convex, x, y), 0, 'the foot is not convex');
  }
  // The floor far from the cone is flat.
  assert.equal(at(convex, 8, 8), 0);
  assert.equal(at(concave, 8, 8), 0);
});

test('select/curvature: the strength acts as its cube, and none selects nothing', async () => {
  const bowl = paraboloid(257, 1);
  const half = (await renderNode(def, { inputs: { in: bowl }, params: { mode: 'concave', radius: 0.01 } })).out;
  const full = (await renderNode(def, { inputs: { in: bowl }, params: { mode: 'concave', radius: 0.01, strength: 1 } })).out;
  const quarter = (await renderNode(def, { inputs: { in: bowl }, params: { mode: 'concave', radius: 0.01, strength: 0.25 } })).out;
  assert.ok(stats(full).max < 1, 'the bowl is gentle enough not to be fully selected');
  expectClose(full, fieldOf(257, (u, v) => 8 * at(half, Math.round(u * 256), Math.round(v * 256))), { max: 1e-4 });
  expectClose(quarter, fieldOf(257, (u, v) => at(half, Math.round(u * 256), Math.round(v * 256)) / 8), { max: 1e-5 });
  expectStats((await renderNode(def, { inputs: { in: 'terrain' }, params: { strength: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/curvature: the bend is physical: it follows the height range, and not the scale of the whole', async () => {
  // A gentle bowl: its mean curvature is all but proportional to the height range.
  const bowl = paraboloid(257, 0.5);
  const base = (await renderNode(def, { inputs: { in: bowl }, params: { mode: 'concave', radius: 0.02 } })).out;
  const tall = (await renderNode(def, { inputs: { in: bowl }, params: { mode: 'concave', radius: 0.02 }, settings: { heightRange: 2 * RANGE } })).out;
  assert.ok(Math.abs(at(tall, 128, 128) / at(base, 128, 128) - 2) <= 1e-3, `at the centre the taller bowl has ${at(tall, 128, 128) / at(base, 128, 128)} times the mask`);
  // Twice the height range on twice the width is the same shape: half the curvature over twice the radius.
  const terrain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const scaled = (await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 2 * TERRAIN, heightRange: 2 * RANGE } })).out;
  expectClose(scaled, terrain, { max: 1e-5 });
});

test('select/curvature: inverted, the mask is its complement', async () => {
  const plain = (await renderNode(def, { inputs: { in: 'terrain' }, params: { radius: 0.02 } })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'terrain' }, params: { radius: 0.02, invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  assert.ok(stats(plain).max > 0.5 && stats(plain).min === 0, 'the fixture has crests, and ground that is not convex');
});

test('select/curvature: two levels of the ladder agree, also where only the finer one is fitted on a coarser grid', async () => {
  // At the default radius, 2.56 texels at 257 and 5.12 at 513, and at half of it both levels fit in one pass.
  for (const mode of ['convex', 'both'] as const) {
    for (const radius of [0.01, 0.005]) {
      const fine = await renderLadder(def, { inputs: { in: 'terrain' }, params: { mode, radius } });
      expectLadder(fine[257].out, fine[513].out, { rel: 0.01 });
    }
  }
  // A radius of 0.03 is 7.68 texels at 257 and 15.36 at 513, which one pass does not hold: the finer level is
  // reduced with a triangle and brought back with a B-spline, which stand for part of the Gaussian. The two
  // then differ by 2 % of the standard deviation.
  for (const mode of ['convex', 'both'] as const) {
    const broad = await renderLadder(def, { inputs: { in: 'terrain' }, params: { mode, radius: 0.03 } });
    expectLadder(broad[257].out, broad[513].out, { rel: 0.03 });
  }
});
