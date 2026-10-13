// tests/nodes/select/roughness.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/roughness.ts';
import { rough } from './terrains.ts';

conformance(def);

// With the test settings the terrain is 4096 m wide and a height of 1 is 1024 m.
const TERRAIN = 4096, RANGE = 1024;
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
/** The roughness that is fully selected: 0.5 at a strength of 0.5, and the strength acts as its cube. */
const full = (strength: number): number => 0.5 / (2 * strength) ** 3;
/** The mask of a roughness: nothing up to half of the full roughness, the smooth step from there to all of it. */
const expected = (roughness: number, strength = 0.5): number => ease((2 * roughness) / full(strength) - 1);

/**
 * Ripples of the given amplitude, `texels` long at 257, along x on a plane tilted along y. Smoothed over a
 * radius r they keep exp(-(k r)^2 / 2) of their amplitude, k = 2 pi / length, so the terrain stands the rest
 * above and below its smoothed surface: a root mean square of amplitude * (1 - exp(...)) / sqrt(2).
 */
const ripples = (amplitude: number, texels: number, res = 257): FieldData =>
  fieldOf(res, (u, v) => 0.3 + 0.2 * v + amplitude * Math.sin((2 * Math.PI * u * 256) / texels));
function roughnessOf(amplitude: number, texels: number, radius: number): number {
  const k = (2 * Math.PI * 256) / texels;
  const relief = (amplitude * (1 - Math.exp(-((k * radius) ** 2) / 2))) / Math.SQRT2;
  return (relief * RANGE) / (radius * TERRAIN);
}

/** The smallest and largest value `margin` texels from the border. */
function inside(f: FieldData, margin: number): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let y = margin; y < f.height - margin; y++) {
    for (let x = margin; x < f.width - margin; x++) {
      min = Math.min(min, at(f, x, y));
      max = Math.max(max, at(f, x, y));
    }
  }
  return { min, max };
}

test('select/roughness: the mask is the smooth step of the relief within the radius, over the radius, in real metres', async () => {
  // Ripples 8 texels long. At a radius of 0.02 nothing of them is left in the smoothed surface; at the default
  // 0.01, 2.56 texels, 13 % of their amplitude is.
  for (const radius of [0.02, 0.01]) {
    for (const share of [0.6, 0.75, 0.9]) {
      // The amplitude whose roughness is that share of the full roughness.
      const amplitude = (share * full(0.5)) / roughnessOf(1, 8, radius);
      assert.ok(Math.abs(roughnessOf(amplitude, 8, radius) / full(0.5) - share) < 1e-9);
      const { out } = await renderNode(def, { inputs: { in: ripples(amplitude, 8) }, params: { radius } });
      const { min, max } = inside(out, 64);
      assert.ok(Math.abs(min - expected(share * full(0.5))) <= 0.02 && Math.abs(max - expected(share * full(0.5))) <= 0.02,
        `radius ${radius}, ${share} of the full roughness: the mask is ${min} to ${max}; expected ${expected(share * full(0.5))}`);
    }
  }
});

test('select/roughness: rough ground is selected up to the border, with no frame along it', async () => {
  // Near the border the smoothed surface has samples on one side only and lies closer to the terrain; what
  // stands out there is not counted, and the border takes the roughness of the ground inside it. The same
  // ripples everywhere are then the same mask everywhere, where the radius spans several of them: a mean over
  // less than one ripple is not a mean, at the border or anywhere.
  for (const radius of [0.05, 0.1]) {
    const amplitude = (0.75 * full(0.5)) / roughnessOf(1, 8, radius);
    const { out } = await renderNode(def, { inputs: { in: ripples(amplitude, 8) }, params: { radius } });
    expectStats(out, { min: [0.49, 0.51], max: [0.49, 0.51] });
  }
  // On a fractal terrain, which is as rough at its border as inside, the texels along the border are selected
  // as much as the band next to them.
  const { out } = await renderNode(def, { inputs: { in: await fixtures.fbm(257) } });
  let along = 0, alongCount = 0, next = 0, nextCount = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      const border = Math.min(x, y, 256 - x, 256 - y);
      if (border < 8) { along += at(out, x, y); alongCount++; } else if (border < 32) { next += at(out, x, y); nextCount++; }
    }
  }
  assert.ok(next / nextCount > 0.15 && next / nextCount < 0.85, `the band inside the border is selected by ${next / nextCount}`);
  assert.ok(Math.abs(along / alongCount - next / nextCount) <= 0.1, `the border is selected by ${along / alongCount}, the band inside it by ${next / nextCount}`);
});

test('select/roughness: smooth ground is not selected: a plane, however steep, and a broad swell', async () => {
  const plane = fieldOf(257, (u, v) => 3 * u + 2 * v);
  for (const radius of [0.0001, 0.01, 0.05]) {
    expectStats((await renderNode(def, { inputs: { in: plane }, params: { radius, strength: 1 } })).out, { min: [0, 0], max: [0, 0] });
  }
  // A swell as long as the terrain bends over many radii: it is a shape, not a roughness.
  const swell = fieldOf(257, (u, v) => 0.5 + 0.3 * Math.sin(2 * Math.PI * u) * Math.cos(2 * Math.PI * v));
  expectStats((await renderNode(def, { inputs: { in: swell } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/roughness: rough ground against smooth: half a terrain of ripples beside half a plane', async () => {
  // Ripples with 1.5 times the full roughness on the left, level ground on the right.
  const amplitude = (1.5 * full(0.5)) / roughnessOf(1, 8, 0.01);
  const halves = fieldOf(257, (u) => 0.3 + (u < 0.5 ? amplitude * Math.sin((2 * Math.PI * u * 256) / 8) : 0));
  const { out } = await renderNode(def, { inputs: { in: halves } });
  let rough = 0, smooth = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x <= 100; x++) if (at(out, x, y) !== 1) rough++;
    for (let x = 156; x < 257; x++) if (at(out, x, y) !== 0) smooth++;
  }
  assert.equal(rough, 0, 'texels of the rippled half that are not fully selected');
  assert.equal(smooth, 0, 'texels of the level half that are selected');
  // Between them the mask falls without a step: the roughness is that of a patch, not of a texel.
  for (let x = 100; x < 156; x++) assert.ok(at(out, x + 1, 128) <= at(out, x, 128) + 1e-6, `the mask rises from texel ${x} to ${x + 1}`);
});

test('select/roughness: the radius is the scale: relief broader than it is shape, not roughness', async () => {
  // Ripples 32 texels long. A radius of 0.005 is 1.28 texels and keeps 97 % of them in the smoothed surface;
  // 0.04 is 10.24 texels and keeps 13 %.
  const amplitude = (0.9 * full(0.5)) / roughnessOf(1, 32, 0.04);
  assert.ok(roughnessOf(amplitude, 32, 0.005) < 0.5 * full(0.5), 'at the small radius the ripples are below half the full roughness');
  const near = await renderNode(def, { inputs: { in: ripples(amplitude, 32) }, params: { radius: 0.005 } });
  expectStats(near.out, { min: [0, 0], max: [0, 0] });
  const far = await renderNode(def, { inputs: { in: ripples(amplitude, 32) }, params: { radius: 0.04 } });
  const { min, max } = inside(far.out, 100);
  assert.ok(Math.abs(min - expected(0.9 * full(0.5))) <= 0.03 && Math.abs(max - expected(0.9 * full(0.5))) <= 0.03, `at a radius of 0.04 the mask is ${min} to ${max}; expected ${expected(0.9 * full(0.5))}`);
});

test('select/roughness: the strength acts as its cube, and none selects nothing', async () => {
  // Ripples with three quarters of the full roughness at a strength of 0.5: the mask is a half.
  const amplitude = (0.75 * full(0.5)) / roughnessOf(1, 8, 0.02);
  const terrain = ripples(amplitude, 8);
  const roughness = roughnessOf(amplitude, 8, 0.02);
  for (const strength of [0.25, 0.45, 0.5, 0.52, 0.6, 1]) {
    const { out } = await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02, strength } });
    const { min, max } = inside(out, 64);
    assert.ok(Math.abs(min - expected(roughness, strength)) <= 0.03 && Math.abs(max - expected(roughness, strength)) <= 0.03,
      `strength ${strength}: the mask is ${min} to ${max}; expected ${expected(roughness, strength)}`);
  }
  assert.equal(expected(roughness, 0.25), 0);
  assert.equal(expected(roughness, 1), 1);
  expectStats((await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02, strength: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/roughness: the roughness is physical: it follows the height range, and not the scale of the whole', async () => {
  // Ripples with 0.6 of the full roughness: with half the height range 0.3, which is not selected, and with
  // 1.5 times the height range 0.9.
  const amplitude = (0.6 * full(0.5)) / roughnessOf(1, 8, 0.02);
  const terrain = ripples(amplitude, 8);
  const low = await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02 }, settings: { heightRange: RANGE / 2 } });
  expectStats(low.out, { min: [0, 0], max: [0, 0] });
  const tall = await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02 }, settings: { heightRange: 1.5 * RANGE } });
  const { min, max } = inside(tall.out, 64);
  assert.ok(Math.abs(min - expected(0.9 * full(0.5))) <= 0.03 && Math.abs(max - expected(0.9 * full(0.5))) <= 0.03, `the mask is ${min} to ${max}`);
  // Twice the height range on twice the width is the same shape.
  const base = await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02 } });
  const scaled = await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02 }, settings: { terrainSize: 2 * TERRAIN, heightRange: 2 * RANGE } });
  expectClose(scaled.out, base.out, { max: 1e-5 });
});

test('select/roughness: inverted, the mask is its complement: smooth ground against rough', async () => {
  const terrain = ripples((0.75 * full(0.5)) / roughnessOf(1, 8, 0.02), 8);
  const plain = (await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02 } })).out;
  const inverted = (await renderNode(def, { inputs: { in: terrain }, params: { radius: 0.02, invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: { invert: true } })).out, { min: [1, 1], max: [1, 1] });
});

test('select/roughness: two levels of the ladder agree on rough ground where the radius spans the detail of both', async () => {
  // A terrain with detail down to 8 cells at 257. Over a radius of 0.005, 1.28 texels at 257, the finer level
  // resolves more of the relief below the radius; over the default 0.01 and over 0.03 both resolve it.
  const share: number[] = [];
  for (const [radius, strength] of [[0.005, 0.62], [0.01, 0.55], [0.03, 0.5]] as const) {
    // At each radius a strength at which this terrain, which is rough throughout, has ground on both sides of the step.
    const levels: FieldData[] = [];
    for (const res of [257, 513]) levels.push((await renderNode(def, { res, inputs: { in: rough(res) }, params: { radius, strength } })).out);
    assert.ok(stats(levels[0]).std > 0.1, `radius ${radius}: the mask has a standard deviation of ${stats(levels[0]).std}`);
    share.push(expectLadder(levels[0], levels[1], { rel: 0.3 }).rel);
  }
  assert.ok(share[1] < 0.05 && share[2] < 0.02, `over a radius of 0.01 the levels differ by ${share[1]} of the standard deviation, over 0.03 by ${share[2]}`);
  assert.ok(share[0] > share[1], `the smallest radius is the one that differs: by ${share[0]}`);
});

test('select/roughness: two levels of the ladder agree on the smooth fixture, where what is measured is its bend', async () => {
  // The conformance suite compares the levels at the defaults, where the fixture is not rough at all and the
  // mask is empty. At full strength the little it stands above its smoothed surface is selected; along the
  // border, where that is taken from the ground inside, the levels differ most.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.005, strength: 1 } });
  assert.ok(stats(levels[257].out).std > 0.1);
  expectLadder(levels[257].out, levels[513].out, { rel: 0.06 });
});
