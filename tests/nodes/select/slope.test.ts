// tests/nodes/select/slope.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/slope.ts';
import { rough } from './terrains.ts';

/** What two levels of the ladder may differ by, as a part of the standard deviation: the default is 0.01. */
const LADDER_TOLERANCE = 0.02;

conformance(def, {
  resolutionTol: {
    value: LADDER_TOLERANCE,
    reason: 'Measures slope by central differences, with half the step at the finer level. On the terrain fixture the mask differs by 1.0 % of its standard deviation between 257 and 513 at the defaults, as much at a radius the finer level smooths on a coarser grid; the test below measures both.',
  },
});

const degrees = (angle: number): number => (angle * Math.PI) / 180;
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * A plane that rises at `tilt` degrees in the direction `towards`. With the test settings a height of 1 is
 * 1024 m and the terrain is 4096 m wide, so a rise of k across the terrain is a slope of k / 4.
 */
function plane(tilt: number, towards: number): FieldData {
  const rise = 4 * Math.tan(degrees(tilt));
  return fieldOf(257, (u, v) => rise * (u * Math.cos(degrees(towards)) + v * Math.sin(degrees(towards))));
}

/** The mask of a plane tilted by `tilt`: 1 in the band, the smooth step across `feather` degrees outside it. */
function expected(tilt: number, lo: number, hi: number, feather: number): number {
  if (tilt >= lo && tilt <= hi) return 1;
  const outside = tilt < lo ? lo - tilt : tilt - hi;
  return outside >= feather ? 0 : ease(1 - outside / feather);
}

/** No smoothing: a radius below a quarter of a texel measures the terrain as it is, up to its border. */
const RAW = { radius: 0.0001 };
const uniform = (value: number, tolerance = 1e-3) => ({ min: [value - tolerance, value + tolerance], max: [value - tolerance, value + tolerance] }) as const;

test('select/slope: a plane inside the band is 1 and one beyond the feather is 0, exactly, whichever way it faces', async () => {
  // The defaults select 40 to 70 degrees with a feather of 5. The tilts stay a degree away from the ends.
  for (const towards of [0, 90, 215]) {
    for (const tilt of [41, 55, 69]) expectStats((await renderNode(def, { inputs: { in: plane(tilt, towards) }, params: RAW })).out, { min: [1, 1], max: [1, 1] });
    for (const tilt of [10, 34, 76, 85]) expectStats((await renderNode(def, { inputs: { in: plane(tilt, towards) }, params: RAW })).out, { min: [0, 0], max: [0, 0] });
  }
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: RAW })).out, { min: [0, 0], max: [0, 0] });
});

test('select/slope: across the feather the mask is the smooth step of the angle, below the band and above it', async () => {
  for (const [tilt, towards] of [[36, 0], [37.5, 90], [39, 140], [71, 300], [72.5, 45], [74, 180]] as const) {
    const { out } = await renderNode(def, { inputs: { in: plane(tilt, towards) }, params: RAW });
    expectStats(out, uniform(expected(tilt, 40, 70, 5), tilt > 70 ? 5e-3 : 1e-3));
  }
  // Other angles: 16 degrees is 4 of a feather of 10 below a band from 20 to 25.
  const wide = await renderNode(def, { inputs: { in: plane(16, 60) }, params: { ...RAW, slopeMin: 20, slopeMax: 25, feather: 10 } });
  expectStats(wide.out, uniform(ease(0.6)));
});

test('select/slope: a feather of 0 is a hard edge, and a feather that reaches past 0 or 90 degrees is still graded', async () => {
  const hard = { ...RAW, slopeMin: 30, slopeMax: 40, feather: 0 };
  expectStats((await renderNode(def, { inputs: { in: plane(29.5, 45) }, params: hard })).out, { min: [0, 0], max: [0, 0] });
  expectStats((await renderNode(def, { inputs: { in: plane(30.5, 45) }, params: hard })).out, { min: [1, 1], max: [1, 1] });
  expectStats((await renderNode(def, { inputs: { in: plane(40.5, 45) }, params: hard })).out, { min: [0, 0], max: [0, 0] });
  // A band from 5 degrees with a feather of 10: level ground is half a feather below it.
  const low = { ...RAW, slopeMin: 5, slopeMax: 20, feather: 10 };
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: low })).out, uniform(ease(0.5)));
  // A band up to 85 degrees with a feather of 10: 88 degrees is three tenths of the feather above it.
  const high = { ...RAW, slopeMin: 70, slopeMax: 85, feather: 10 };
  expectStats((await renderNode(def, { inputs: { in: plane(88, 10) }, params: high })).out, uniform(ease(0.7), 5e-3));
  // The whole range selects everything, level ground and the steepest plane.
  const all = { ...RAW, slopeMin: 0, slopeMax: 90 };
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: all })).out, { min: [1, 1], max: [1, 1] });
  expectStats((await renderNode(def, { inputs: { in: plane(89, 200) }, params: all })).out, { min: [1, 1], max: [1, 1] });
});

test('select/slope: slopes are physical: they follow the height range and the terrain size', async () => {
  // rampX rises by the height range across the terrain: 14.04 degrees with the test settings.
  const band = { ...RAW, slopeMin: 20, slopeMax: 45, feather: 10 };
  const flat = Math.atan(0.25) * 180 / Math.PI, tall = Math.atan(0.5) * 180 / Math.PI;
  expectStats((await renderNode(def, { inputs: { in: 'rampX' }, params: band })).out, uniform(expected(flat, 20, 45, 10)));
  // Twice the height range: atan(1 / 2) is 26.57 degrees, inside the band.
  expectStats((await renderNode(def, { inputs: { in: 'rampX' }, params: band, settings: { heightRange: 2048 } })).out, { min: [1, 1], max: [1, 1] });
  assert.ok(tall > 20 && flat < 20 && flat > 10);
  // Twice the height range on twice the width is the same slope everywhere.
  const base = await renderNode(def, { inputs: { in: 'terrain' } });
  const scaled = await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 8192, heightRange: 2048 } });
  expectClose(scaled.out, base.out, { max: 1e-5 });
});

test('select/slope: the radius smooths before measuring: ripples narrower than it do not count', async () => {
  // A plane at 10 degrees carrying ripples 8 texels long whose steeper sides reach 44 degrees.
  const rise = 4 * Math.tan(degrees(10));
  const rippled = fieldOf(257, (u) => rise * u + 0.016 * Math.sin((2 * Math.PI * u * 256) / 8));
  const band = { slopeMin: 20, slopeMax: 90, feather: 0 };
  const raw = await renderNode(def, { inputs: { in: rippled }, params: { ...band, ...RAW } });
  assert.ok(stats(raw.out).mean > 0.3, `unsmoothed, the steep sides of the ripples are selected: the mean is ${stats(raw.out).mean}`);
  // A radius of 16 texels leaves e^-79 of them: what is measured is the plane.
  const smooth = await renderNode(def, { inputs: { in: rippled }, params: { ...band, radius: 16 / 256 } });
  let selected = 0;
  for (let y = 0; y < 257; y++) for (let x = 24; x <= 232; x++) if (at(smooth.out, x, y) !== 0) selected++;
  assert.equal(selected, 0, 'texels of the smoothed plane that are selected');
});

test('select/slope: a smoothed plane is the plane it was, up to the border, at any radius', async () => {
  // 35 degrees is inside a band from 34 to 36. A blur that clamped at the border would flatten the plane there.
  // 0.005 and 0.03 are smoothed in one pass at 257; 0.1 and 0.25 on a coarser grid.
  for (const radius of [0.005, 0.03, 0.1, 0.25]) {
    for (const towards of [0, 70, 225]) {
      const { out } = await renderNode(def, { inputs: { in: plane(35, towards) }, params: { radius, slopeMin: 34, slopeMax: 36, feather: 0 } });
      expectStats(out, { min: [1, 1], max: [1, 1] });
    }
  }
});

test('select/slope: a cone is selected on its flank and not on its floor, and inverted the other way round', async () => {
  // The flank is at 45 degrees with the test settings; the floor is level.
  const plain = (await renderNode(def, { inputs: { in: 'cone' }, params: RAW })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'cone' }, params: { ...RAW, invert: true } })).out;
  let wrong = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 8 && r < 62 && (at(plain, x, y) !== 1 || at(inverted, x, y) !== 0)) wrong++;
      if (r > 66 && (at(plain, x, y) !== 0 || at(inverted, x, y) !== 1)) wrong++;
    }
  }
  assert.equal(wrong, 0, 'texels of the flank or the floor with the wrong value');
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
});

test('select/slope: two levels of the ladder agree within the declared tolerance, also where only the finer one smooths on a coarser grid', async () => {
  // At the default radius both levels smooth in one pass: 1.28 texels at 257 and 2.56 at 513.
  const fine = await renderLadder(def, { inputs: { in: 'terrain' } });
  const atDefault = expectLadder(fine[257].out, fine[513].out, { rel: LADDER_TOLERANCE });
  assert.ok(atDefault.rel > 0.002, `the levels differ by ${atDefault.rel} of the standard deviation: the central difference has half the step`);
  // A radius of 0.03 is 7.68 texels at 257 and 15.36 at 513, which one pass does not hold. The band is one the
  // smoothed fixture has slopes in.
  const broad = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.03, slopeMin: 20, slopeMax: 45 } });
  expectLadder(broad[257].out, broad[513].out, { rel: LADDER_TOLERANCE });
  // No texel differs by more than a slope a degree apart makes across a feather of 5, the border included.
  expectLadder(fine[257].out, fine[513].out, { max: 0.25 });
  expectLadder(broad[257].out, broad[513].out, { max: 0.25 });
});

test('select/slope: on rough ground the radius is what makes a preview show what the build selects', async () => {
  // A terrain with detail down to 8 cells at 257. Measured as it is, the finer level resolves steeper faces;
  // smoothed over 0.02, both levels measure the same ground.
  const share: number[] = [];
  for (const radius of [0.0001, 0.02]) {
    const levels: FieldData[] = [];
    for (const res of [257, 513]) levels.push((await renderNode(def, { res, inputs: { in: rough(res) }, params: { radius } })).out);
    share.push(expectLadder(levels[0], levels[1], { rel: 0.2 }).rel);
  }
  assert.ok(share[1] < 0.03, `smoothed over 0.02 the levels differ by ${share[1]} of the standard deviation`);
  assert.ok(share[0] > 2 * share[1], `unsmoothed they differ by ${share[0]}, smoothed by ${share[1]}`);
});
