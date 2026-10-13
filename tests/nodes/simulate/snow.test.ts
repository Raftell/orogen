// tests/nodes/simulate/snow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectMask, expectStats, fieldOf, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/snow.ts';
import { SNOW_COVER } from '../../../src/core/nodes/simulate/_constants.ts';
import { combine, count, meanOf, planeFacing, steepestPair, tanDeg } from './_erosion-rig.ts';

conformance(def, {
  resolutionTol: {
    value: 0.05,
    reason: 'Snow slides and creeps over the slopes each level resolves, and the edge of the cover lies within a texel of that level (simulation.md 2.8). Measured between 257 and 513 on the terrain fixture: 0.0004 of the standard deviation for out, 0.032 for snow and 0.034 for depth; 0.002 for both between 513 and 1025.',
  },
});

const alone = { mask: null } as const;
/** Snow everywhere and none of it melting: the snow line lies below every fixture. */
const EVERYWHERE = { snowLine: -1, band: 0.001, melt: 0 };
/** The default snowfall, as the float32 a field holds. */
const FALL = Math.fround(0.02);
/** Snow thinner than this is on its way down a face, not at rest. */
const RESTING = FALL / 40;

test('simulate/snow: out is the terrain plus the depth, and snow is the cover of that depth', async () => {
  const terrain = fixtures.terrain(257);
  const { out, snow, depth } = await renderNode(def, { inputs: { in: terrain, ...alone } });
  assert.ok(stats(depth).min >= 0, `the thinnest snow is ${stats(depth).min}`);
  expectIdentical(out, combine(terrain, depth, (h, d) => h + d));
  expectMask(snow);
  const cover = Math.fround(SNOW_COVER * 0.02);
  assert.equal(count(snow, (v, i) => Math.abs(v - Math.min(1, depth.data[i]! / cover)) > 1e-5), 0, 'texels whose cover is not saturate(depth / (SNOW_COVER * snowfall))');
  // At the defaults the fixture has ground on both sides of the snow line: some of it is covered, some bare.
  const covered = meanOf(snow);
  assert.ok(covered > 0.1 && covered < 0.9, `${covered} of the terrain is covered`);
});

test('simulate/snow: what falls is the snowfall; on one level without melt all of it lies', async () => {
  // Reach 0.01 runs on the 257 grid alone.
  const terrain = fixtures.terrain(257);
  const all = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { ...EVERYWHERE, size: 0.01 }, wants: ['depth'] });
  assert.ok(Math.abs(meanOf(all.depth) - 0.02) <= 1e-4 * 0.02, `mean(depth) is ${meanOf(all.depth)} of a snowfall of 0.02`);
  // With a snow line, with melt and with a mask, less lies than fell.
  for (const [params, mask] of [[{ size: 0.01 }, null], [{ ...EVERYWHERE, melt: 1, size: 0.01 }, null], [{ ...EVERYWHERE, size: 0.01 }, 'mask']] as const) {
    const { depth } = await renderNode(def, { inputs: { in: terrain, mask }, params, wants: ['depth'] });
    assert.ok(meanOf(depth) < 0.9 * 0.02, `mean(depth) is ${meanOf(depth)} with ${JSON.stringify(params)}${mask ? ' under a mask' : ''}`);
  }
});

test('simulate/snow: no snowfall leaves the terrain as it is', async () => {
  const terrain = fixtures.terrain(257);
  const { out, snow, depth } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { snowfall: 0 } });
  expectIdentical(out, terrain);
  expectStats(snow, { min: [0, 0], max: [0, 0] });
  expectStats(depth, { min: [0, 0], max: [0, 0] });
});

test('simulate/snow: snow lies above the snow line and not below it', async () => {
  // A ramp from 0 to 1 at 14 degrees, on which nothing slides: the snow line at 0.5 lies at its middle column.
  const { depth, snow } = await renderNode(def, { inputs: { in: 'rampX', ...alone }, params: { band: 0.02, melt: 0 } });
  // Snow creeps a little way down from the line and no further: 28 texels below it there is none to speak of.
  assert.ok(at(depth, 100, 128) < 1e-9, `below the snow line there is no snow: ${at(depth, 100, 128)}`);
  assert.ok(at(snow, 100, 128) < 1e-6, `below the snow line nothing is covered: ${at(snow, 100, 128)}`);
  assert.equal(at(depth, 60, 128), 0, 'far below the snow line there is no snow at all');
  assert.ok(Math.abs(at(depth, 200, 128) - 0.02) < 1e-4, `above it lies the snowfall: ${at(depth, 200, 128)}`);
  assert.equal(at(snow, 200, 128), 1);
  // A higher snow line leaves less of the ramp covered.
  const higher = await renderNode(def, { inputs: { in: 'rampX', ...alone }, params: { band: 0.02, melt: 0, snowLine: 0.8 }, wants: ['snow'] });
  assert.ok(meanOf(higher.snow) < 0.5 * meanOf(snow), `${meanOf(higher.snow)} is covered with the line at 0.8, ${meanOf(snow)} at 0.5`);
});

test('simulate/snow: it lies on gentle high ground, slides off a steep face and drifts at its foot', async () => {
  // A table 0.3 high with flanks of 63 degrees (a rise of 0.3 over a run of 0.0375 widths), on level ground.
  const table = fieldOf(257, (u, v) => 0.3 + 0.3 * Math.min(1, Math.max(0, (0.3 - Math.hypot(u - 0.5, v - 0.5)) / 0.0375)));
  const { depth } = await renderNode(def, { inputs: { in: table, ...alone }, params: { ...EVERYWHERE, size: 0.05 }, wants: ['depth'] });
  // The face lies between 67 and 77 texels from the centre.
  const top = at(depth, 128, 128), face = at(depth, 128 + 72, 128), foot = at(depth, 128 + 77, 128), far = at(depth, 250, 128);
  assert.ok(Math.abs(top - FALL) < 1e-5, `on the table top lies the snowfall: ${top}`);
  assert.ok(Math.abs(far - FALL) < 1e-5, `on the plain lies the snowfall: ${far}`);
  assert.ok(face < 0.25 * FALL, `on the face ${face} is left`);
  assert.ok(foot > 2 * FALL, `at its foot the drift is ${foot} deep`);
});

test('simulate/snow: on the cone no snow that came to rest lies steeper than the slip angle', async () => {
  // The flank stands at 45 degrees; at a slip angle of 40 the snow leaves the flank within the reach.
  const { out, depth } = await renderNode(def, { inputs: { in: 'cone', ...alone }, params: { ...EVERYWHERE, slipAngle: 40, size: 0.25 } });
  const steepest = steepestPair(out, (i) => depth.data[i]! > RESTING);
  assert.ok(steepest <= 1.05 * tanDeg(40), `snow rests at ${steepest}; the tangent of the slip angle is ${tanDeg(40)}`);
  assert.ok(at(depth, 128 + 30, 128) < 0.25 * FALL, `on the flank lies ${at(depth, 128 + 30, 128)}`);
  assert.ok(at(depth, 128 + 66, 128) > 1.25 * FALL, `at the foot lies ${at(depth, 128 + 66, 128)}, more than fell there`);
});

test('simulate/snow: a slope steeper than the slip angle sheds its snow whichever way it faces', async () => {
  // As for the layer of simulate/sediment: where a plane faces between a row and a diagonal no pair of neighbours
  // is as steep as the plane, and the snow slides all the same, as far as on a plane that faces a row.
  const steepAt = (factor: number) => (Math.atan(factor * tanDeg(10)) * 180) / Math.PI;
  const params = { ...EVERYWHERE, snowLine: -3, slipAngle: 10, size: 0.1 };
  const thinnest: number[] = [];
  for (const facing of [0, 22.5, 112.5]) {
    const shed = await renderNode(def, { inputs: { in: fieldOf(257, planeFacing(steepAt(1.06), facing)), ...alone }, params, wants: ['depth'] });
    thinnest.push(stats(shed.depth).min / FALL);
    assert.ok(stats(shed.depth).min < 0.85 * FALL, `facing ${facing}: where the steeper plane is barest lies ${stats(shed.depth).min}`);
    // A gentler plane it does not slide off: it creeps, which leaves an even slope as it was but for the borders
    // the snow leaves and gathers at. In the middle of the plane lies what fell.
    const kept = await renderNode(def, { inputs: { in: fieldOf(257, planeFacing(steepAt(0.94), facing)), ...alone }, params, wants: ['depth'] });
    assert.ok(Math.abs(at(kept.depth, 128, 128) - FALL) < 0.02 * FALL, `facing ${facing}: in the middle of the gentler plane lies ${at(kept.depth, 128, 128)}`);
    assert.ok(at(shed.depth, 128, 128) < 0.9 * at(kept.depth, 128, 128) || stats(shed.depth).min < 0.5 * stats(kept.depth).min + 0.25 * FALL, `facing ${facing}: the steeper plane sheds more than the gentler one`);
  }
  assert.ok(Math.max(...thinnest) - Math.min(...thinnest) < 0.03, `the share left where each plane is barest: ${thinnest.join(', ')}`);
});

test('simulate/snow: the slope that faces the sun keeps less, as far as the exposure says', async () => {
  // A roof: two slopes of 14 degrees, one facing +x and one facing -x. The sun stands in the direction +x.
  const roof = fieldOf(257, (u) => 1 - Math.abs(2 * u - 1));
  const run = async (exposure: number) => (await renderNode(def, { inputs: { in: roof, ...alone }, params: { snowLine: -1, band: 0.001, melt: 0.5, exposure, angle: 0 }, wants: ['depth'] })).depth;
  const lit = await run(1);
  const sunny = at(lit, 192, 128), shaded = at(lit, 64, 128);
  assert.ok(sunny < 0.85 * shaded, `the sunny slope holds ${sunny}, the shaded one ${shaded}`);
  const even = await run(0);
  assert.ok(Math.abs(at(even, 192, 128) - at(even, 64, 128)) < 1e-6, 'without exposure both slopes melt alike');
  // More melt, less snow.
  assert.ok(meanOf(even) < 0.6 * 0.02, `with half the snowfall melting ${meanOf(even)} lies`);
});
