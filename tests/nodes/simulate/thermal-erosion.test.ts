// tests/nodes/simulate/thermal-erosion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectStats, fieldOf, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/thermal-erosion.ts';
import { combine, count, meanChange, meanOf, planeFacing, reach, steepestPair, tanDeg } from './_erosion-rig.ts';

conformance(def, {
  resolutionTol: {
    value: 0.04,
    reason: 'Relaxes the slopes it finds, and a finer level resolves steeper pairs of the same terrain (simulation.md 2.8). Measured between 257 and 513 on the terrain fixture: 0.0002 of the standard deviation for out, 0.019 for wear and 0.014 for deposit.',
  },
});

const alone = { mask: null } as const;

test('simulate/thermal-erosion: a terrain with no slope above the talus angle is returned bit for bit', async () => {
  // The notch fixture is nowhere steeper than 10.1 degrees with the test settings.
  const notch = fixtures.notch(257);
  assert.ok(steepestPair(notch) < tanDeg(35));
  const { out, wear, deposit } = await renderNode(def, { inputs: { in: notch, ...alone } });
  expectIdentical(out, notch);
  expectStats(wear, { min: [0, 0], max: [0, 0] });
  expectStats(deposit, { min: [0, 0], max: [0, 0] });
});

test('simulate/thermal-erosion: a cone steeper than the talus angle relaxes to it within the reach, and no material is lost', async () => {
  // The flank of the cone stands at 45 degrees and its radius is 0.25: the reach covers it.
  const cone = fixtures.cone(257);
  assert.ok(steepestPair(cone) > 0.99);
  const { out } = await renderNode(def, { inputs: { in: cone, ...alone }, params: { size: 0.25 }, wants: ['out'] });
  const talus = tanDeg(35);
  const steepest = steepestPair(out);
  assert.ok(steepest <= 1.05 * talus, `the steepest pair is at ${steepest}; the talus tangent is ${talus}`);
  // An even slope at the talus angle, not a flattened heap: half-way down, the flank stands at it.
  const flank = ((at(out, 128 + 16, 128) - at(out, 128 + 48, 128)) * 1024) / (32 * 16);
  assert.ok(flank > 0.95 * talus && flank <= 1.05 * talus, `the flank stands at ${flank}`);
  // What left the tip lies around the foot: the cone is lower and wider.
  assert.ok(at(out, 128, 128) < 0.9, `the tip is at ${at(out, 128, 128)}`);
  assert.ok(at(out, 128 + 66, 128) > 0.01, `the floor beyond the old foot is at ${at(out, 128 + 66, 128)}`);
  const drift = Math.abs(meanOf(out) - meanOf(cone));
  const allowed = 2e-6 + 1e-4 * meanChange(out, cone);
  assert.ok(drift <= allowed, `|mean(out) - mean(in)| is ${drift}; allowed ${allowed}`);
  // A lower talus angle spreads the cone further.
  const low = await renderNode(def, { inputs: { in: cone, ...alone }, params: { talus: 20, size: 0.25 }, wants: ['out'] });
  assert.ok(at(low.out, 128, 128) < at(out, 128, 128) - 0.1, `the tip is at ${at(low.out, 128, 128)} at 20 degrees`);
});

test('simulate/thermal-erosion: a cone collapses into a round cone, and a slope collapses whichever way it faces', async () => {
  // Thresholds taken between two texels alone leave a heap as an octagon: its contour lies 6 % further out along
  // the axes and the diagonals than between them. With the slope at the middle of each pair it is round.
  const cone = fixtures.cone(257);
  for (const talus of [35, 20]) {
    const { out } = await renderNode(def, { inputs: { in: cone, ...alone }, params: { talus, size: 0.25 }, wants: ['out'] });
    const radii = [0, 22.5, 45, 67.5, 90, 135, 180, 202.5, 270, 315].map((degrees) => reach(out, degrees, 0.1));
    const spread = Math.max(...radii) - Math.min(...radii);
    assert.ok(Math.min(...radii) > 40, `talus ${talus}: the contour at 0.1 lies ${Math.min(...radii)} texels out`);
    assert.ok(spread <= 1.5, `talus ${talus}: the contour at 0.1 lies between ${Math.min(...radii)} and ${Math.max(...radii)} texels from the centre`);
  }
  // A plane 6 % steeper than the talus slope gives way from its upper border down, also where it faces between a
  // row and a diagonal and no pair of neighbours is as steep as the talus slope; 6 % gentler, it stays bit for bit.
  for (const facing of [0, 22.5, 45, 112.5]) {
    const steep = fieldOf(257, planeFacing((Math.atan(1.06 * tanDeg(10)) * 180) / Math.PI, facing));
    const moved = await renderNode(def, { inputs: { in: steep, ...alone }, params: { talus: 10, size: 0.1 }, wants: ['wear'] });
    assert.ok(stats(moved.wear).max > 1e-4, `facing ${facing}: the largest wear on the steeper plane is ${stats(moved.wear).max}`);
    const gentle = fieldOf(257, planeFacing((Math.atan(0.94 * tanDeg(10)) * 180) / Math.PI, facing));
    const still = await renderNode(def, { inputs: { in: gentle, ...alone }, params: { talus: 10, size: 0.1 }, wants: ['out'] });
    expectIdentical(still.out, gentle);
  }
});

test('simulate/thermal-erosion: what leaves a slope arrives below it, on one level and across a refinement', async () => {
  const terrain = fixtures.terrain(257);
  // Reach 0.01 runs on the 257 grid alone: the exchange of every pair cancels.
  const one = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 20, size: 0.01 }, wants: ['out'] });
  const moved = meanChange(one.out, terrain);
  assert.ok(moved > 1e-4, `the mean change is ${moved}`);
  const drift = Math.abs(meanOf(one.out) - meanOf(terrain));
  assert.ok(drift <= 2e-6 + 1e-4 * moved, `|mean(out) - mean(in)| is ${drift} for a mean change of ${moved}`);
  // Reach 0.1 starts on 129 and refines once. The coarse grid's border ring stands for half a cell, and the
  // interpolation gives its change that weight where the exchange counted it whole: the mean drifts by the
  // change on the ring, which is a 1/64 of the texels of the 129 grid.
  const two = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 20, size: 0.1 }, wants: ['out'] });
  const movedTwo = meanChange(two.out, terrain);
  assert.ok(movedTwo > 2 * moved, `the mean change is ${movedTwo} at the longer reach`);
  const driftTwo = Math.abs(meanOf(two.out) - meanOf(terrain));
  assert.ok(driftTwo <= movedTwo / 64, `across a refinement |mean(out) - mean(in)| is ${driftTwo} for a mean change of ${movedTwo}`);
});

test('simulate/thermal-erosion: with full removal nothing is laid down and the terrain only loses height', async () => {
  const terrain = fixtures.terrain(257);
  const { out, wear, deposit } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 20, removal: 1 } });
  assert.equal(count(out, (v, i) => v > terrain.data[i]!), 0, 'texels above the input');
  expectStats(deposit, { min: [0, 0], max: [0, 0] });
  assert.ok(meanOf(wear) > 1e-4, `the mean wear is ${meanOf(wear)}`);
  const kept = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 20 }, wants: ['out'] });
  assert.ok(meanOf(out) < meanOf(kept.out) - 1e-4, 'removing the fallen material lowers the terrain');
});

test('simulate/thermal-erosion: wear and deposit are the two sides of the change, never both at one texel', async () => {
  const terrain = fixtures.terrain(257);
  const { out, wear, deposit } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 25 } });
  assert.equal(count(wear, (v, i) => v < 0 || deposit.data[i]! < 0 || (v > 0 && deposit.data[i]! > 0)), 0, 'texels with a negative output or with both');
  const rebuilt = combine(combine(terrain, wear, (h, w) => h - w), deposit, (h, d) => h + d);
  assert.ok(stats(combine(out, rebuilt, (a, b) => Math.abs(a - b))).max <= 1e-7, 'out is in - wear + deposit');
  // Material leaves the steep flanks and gathers below them: both outputs show something.
  assert.ok(stats(wear).max > 0.005 && stats(deposit).max > 0.005, `largest wear ${stats(wear).max}, largest deposit ${stats(deposit).max}`);
  // Crests wear and hollows fill: the highest ground only loses, the lowest only gains.
  const s = stats(terrain);
  assert.equal(count(deposit, (v, i) => v > 0 && terrain.data[i]! > s.max - 0.01), 0, 'deposit on the highest crest');
  assert.equal(count(wear, (v, i) => v > 0 && terrain.data[i]! < s.min + 0.01), 0, 'wear in the deepest hollow');
});

test('simulate/thermal-erosion: nothing moves where the mask is 0, and a mask of 0 everywhere returns the input', async () => {
  const terrain = fixtures.terrain(257), mask = fixtures.mask(257);
  const none = await renderNode(def, { inputs: { in: terrain, mask: 'zero' }, params: { talus: 20 }, wants: ['out'] });
  expectIdentical(none.out, terrain);
  const part = await renderNode(def, { inputs: { in: terrain, mask }, params: { talus: 20 }, wants: ['out'] });
  assert.equal(count(part.out, (v, i) => mask.data[i] === 0 && v !== terrain.data[i]), 0, 'texels outside the mask that changed');
  assert.ok(count(part.out, (v, i) => mask.data[i] === 1 && v !== terrain.data[i]) > 1000, 'texels inside the mask that changed');
  // The exchange of a pair is scaled by the smaller of its two mask values, so the masked run still loses nothing.
  const drift = Math.abs(meanOf(part.out) - meanOf(terrain));
  assert.ok(drift <= 2e-6 + 1e-4 * meanChange(part.out, terrain), `|mean(out) - mean(in)| is ${drift} under a mask`);
});

test('simulate/thermal-erosion: strength 0 runs no iteration and returns the input; more strength and a lower talus move more', async () => {
  const terrain = fixtures.terrain(257);
  const run = async (params: Record<string, number>) => (await renderNode(def, { inputs: { in: terrain, ...alone }, params, wants: ['out'] })).out;
  // With a reach of several levels: the refinement of an unchanged terrain is the input (simulation.md 1.7 item 4).
  expectIdentical(await run({ strength: 0, size: 0.1, talus: 20 }), terrain);
  // A reach of 0.02: five texels of the fixture's grid, over which a slope has the iterations to tell the angles apart.
  const weak = meanChange(await run({ strength: 0.1, talus: 25, size: 0.02 }), terrain);
  const full = meanChange(await run({ strength: 1, talus: 25, size: 0.02 }), terrain);
  const low = meanChange(await run({ strength: 1, talus: 15, size: 0.02 }), terrain);
  assert.ok(weak > 0 && full > 1.5 * weak, `mean change ${weak} at strength 0.1 and ${full} at 1`);
  assert.ok(low > 1.5 * full, `mean change ${full} at 25 degrees and ${low} at 15`);
  // At 89 degrees no pair of the fixture is steep enough.
  expectIdentical(await run({ talus: 89 }), terrain);
});
