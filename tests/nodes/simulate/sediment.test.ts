// tests/nodes/simulate/sediment.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectStats, fieldOf, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/sediment.ts';
import { combine, count, meanOf, planeFacing, steepestPair, tanDeg } from './_erosion-rig.ts';

conformance(def, {
  resolutionTol: {
    value: 0.02,
    reason: 'The layer slides over the slopes each level resolves, and a finer level resolves steeper ones (simulation.md 2.8). Measured between 257 and 513 on the terrain fixture: 0.0002 of the standard deviation for out and 0.004 for depth; 0.012 between 129 and 257.',
  },
});

const alone = { mask: null } as const;
const THICKNESS = Math.fround(0.02);

test('simulate/sediment: on ground gentler than the angle of repose the layer stays as it was laid', async () => {
  // The notch fixture is nowhere steeper than 10.1 degrees: nothing slides.
  const notch = fixtures.notch(257);
  const { out, depth } = await renderNode(def, { inputs: { in: notch, ...alone } });
  expectStats(depth, { min: [THICKNESS, THICKNESS], max: [THICKNESS, THICKNESS] });
  expectIdentical(out, combine(notch, depth, (h, d) => h + d));
});

test('simulate/sediment: a slope steeper than the angle of repose sheds the layer alike whichever way it faces', async () => {
  // A plane 6 % steeper than the repose slope. Where it faces between a row and a diagonal no pair of neighbours
  // is as steep as the repose slope; the layer still slides, from the upper border down, and as far as on a plane
  // that faces a row. So little above the angle it moves slowly: the upper border loses a fifth. 6 % gentler, it stays.
  const steepAt = (factor: number) => (Math.atan(factor * tanDeg(10)) * 180) / Math.PI;
  const thinnest: number[] = [];
  for (const facing of [0, 22.5, 45, 112.5]) {
    const shed = await renderNode(def, { inputs: { in: fieldOf(257, planeFacing(steepAt(1.06), facing)), ...alone }, params: { repose: 10, size: 0.1 }, wants: ['depth'] });
    thinnest.push(stats(shed.depth).min / THICKNESS);
    assert.ok(stats(shed.depth).min < 0.85 * THICKNESS, `facing ${facing}: where the steeper plane is barest ${stats(shed.depth).min} is left`);
    const kept = await renderNode(def, { inputs: { in: fieldOf(257, planeFacing(steepAt(0.94), facing)), ...alone }, params: { repose: 10, size: 0.1 }, wants: ['depth'] });
    expectStats(kept.depth, { min: [THICKNESS, THICKNESS], max: [THICKNESS, THICKNESS] });
  }
  assert.ok(Math.max(...thinnest) - Math.min(...thinnest) < 0.03, `the share left where each plane is barest: ${thinnest.join(', ')}`);
});

test('simulate/sediment: out is the bed plus the depth, and no material is made or lost on one level', async () => {
  // Reach 0.01 runs on the 257 grid alone.
  for (const mask of [null, 'mask'] as const) {
    const terrain = fixtures.terrain(257);
    const { out, depth } = await renderNode(def, { inputs: { in: terrain, mask }, params: { size: 0.01, repose: 20 } });
    assert.ok(stats(depth).min >= 0, `the thinnest layer is ${stats(depth).min}`);
    expectIdentical(out, combine(terrain, depth, (h, d) => h + d));
    const laid = THICKNESS * (mask ? meanOf(fixtures.mask(257)) : 1);
    assert.ok(Math.abs(meanOf(depth) - laid) <= 1e-5 * THICKNESS, `mean(depth) is ${meanOf(depth)}; ${laid} was laid down`);
    // It did slide: the layer is no longer even.
    assert.ok(stats(depth).max > 1.25 * THICKNESS && stats(depth).min < 0.5 * THICKNESS, `the layer is between ${stats(depth).min} and ${stats(depth).max} thick`);
  }
});

test('simulate/sediment: the layer slides off a face steeper than its angle of repose and gathers at the foot', async () => {
  // The flank of the cone stands at 45 degrees; its foot is 64 texels from the tip.
  const cone = fixtures.cone(257);
  const { out, depth } = await renderNode(def, { inputs: { in: cone, ...alone }, params: { size: 0.25, thickness: 0.02 } });
  const flank = at(depth, 128 + 32, 128), foot = at(depth, 128 + 66, 128), far = at(depth, 128 + 120, 128);
  assert.ok(flank < 0.002, `on the flank ${flank} is left of 0.02`);
  assert.ok(foot > 0.04, `at the foot lies ${foot}`);
  assert.ok(Math.abs(far - 0.02) < 1e-6, `far out on the floor the layer is as laid: ${far}`);
  // Where sediment came to rest, its surface is no steeper than the angle of repose.
  const steepest = steepestPair(out, (i) => depth.data[i]! > 1e-4);
  assert.ok(steepest <= 1.05 * tanDeg(33), `sediment rests at ${steepest}; the tangent of repose is ${tanDeg(33)}`);
});

test('simulate/sediment: it fills the hollows of a terrain and leaves its steep ground bare', async () => {
  const terrain = fixtures.terrain(257);
  const { depth } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { size: 0.1, repose: 15, thickness: 0.02 } });
  // The fixture's hollows are its lowest ground and its crests its highest.
  const s = stats(terrain);
  let low = 0, lows = 0, high = 0, highs = 0;
  for (let i = 0; i < depth.data.length; i++) {
    if (terrain.data[i]! < s.p01) { low += depth.data[i]!; lows++; }
    if (terrain.data[i]! > s.p99) { high += depth.data[i]!; highs++; }
  }
  assert.ok(low / lows > 2 * 0.02, `the lowest hundredth of the terrain holds ${low / lows} on average`);
  assert.ok(high / highs < 0.5 * 0.02, `the highest hundredth holds ${high / highs}`);
  assert.ok(count(depth, (v) => v < 0) === 0, 'a negative depth');
});

test('simulate/sediment: no thickness, no sediment; a thicker layer and a lower angle of repose move more', async () => {
  const terrain = fixtures.terrain(257);
  const none = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { thickness: 0 } });
  expectIdentical(none.out, terrain);
  expectStats(none.depth, { min: [0, 0], max: [0, 0] });
  const spread = async (params: Record<string, number>) => stats((await renderNode(def, { inputs: { in: terrain, ...alone }, params, wants: ['depth'] })).depth).std;
  const steep = await spread({ repose: 40 }), flat = await spread({ repose: 15 });
  assert.ok(flat > 1.5 * steep, `the layer varies by ${steep} at 40 degrees and by ${flat} at 15`);
  // A reach below half a texel moves nothing: the layer lies as laid.
  const still = await renderNode(def, { res: 129, inputs: { in: fixtures.terrain(129), ...alone }, params: { size: 0.001 }, wants: ['depth'] });
  expectStats(still.depth, { min: [THICKNESS, THICKNESS], max: [THICKNESS, THICKNESS] });
});

test('simulate/sediment: the mask says where material is laid down, not where it may slide', async () => {
  // A step: high ground on the left with the mask on it, low ground on the right without.
  const step = fieldOf(257, (u) => (u < 0.5 ? 0.6 : 0.2));
  const left = fieldOf(257, (u) => (u < 0.5 ? 1 : 0));
  const { depth } = await renderNode(def, { inputs: { in: step, mask: left }, params: { size: 0.05, thickness: 0.02 } });
  // The step lies between the columns 127 and 128.
  assert.ok(at(depth, 128, 128) > 0.005, `sediment slid over the edge onto unmasked ground: ${at(depth, 128, 128)}`);
  assert.ok(at(depth, 127, 128) < 0.005, `the edge of the high ground lost its layer: ${at(depth, 127, 128)}`);
  assert.equal(at(depth, 250, 128), 0, 'far from the edge the unmasked ground is bare');
  assert.ok(Math.abs(at(depth, 20, 128) - 0.02) < 1e-6, 'far from the edge the masked ground holds what was laid');
});
