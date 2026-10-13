// tests/nodes/select/aspect.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/aspect.ts';

conformance(def);

const degrees = (angle: number): number => (angle * Math.PI) / 180;
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * A plane tilted by `tilt` degrees that faces the direction `facing`: it falls that way, so it rises the
 * opposite way. With the test settings a rise of k across the terrain is a slope of k / 4.
 */
function plane(tilt: number, facing: number): FieldData {
  const rise = 4 * Math.tan(degrees(tilt));
  return fieldOf(257, (u, v) => -rise * (u * Math.cos(degrees(facing)) + v * Math.sin(degrees(facing))));
}

/** No smoothing: a radius below a quarter of a texel measures the terrain as it is. */
const RAW = { radius: 0.0001 };
const uniform = (value: number, tolerance = 1e-3) => ({ min: [value - tolerance, value + tolerance], max: [value - tolerance, value + tolerance] }) as const;

test('select/aspect: directions are those of the frame: 0 faces +X, 90 faces +Y, and larger angles turn clockwise', async () => {
  // A plane that falls towards +X: its heights decrease with u. Twice the height range across the terrain is 26.57 degrees.
  const east = fieldOf(257, (u) => 2 - 2 * u);
  expectStats((await renderNode(def, { inputs: { in: east }, params: { ...RAW, angle: 0 } })).out, { min: [1, 1], max: [1, 1] });
  expectStats((await renderNode(def, { inputs: { in: east }, params: { ...RAW, angle: 180 } })).out, { min: [0, 0], max: [0, 0] });
  // One that falls towards +Y, down the picture: its heights decrease with v.
  const south = fieldOf(257, (_u, v) => 2 - 2 * v);
  expectStats((await renderNode(def, { inputs: { in: south }, params: { ...RAW, angle: 90 } })).out, { min: [1, 1], max: [1, 1] });
  expectStats((await renderNode(def, { inputs: { in: south }, params: { ...RAW, angle: 270 } })).out, { min: [0, 0], max: [0, 0] });
  expectStats((await renderNode(def, { inputs: { in: south }, params: { ...RAW, angle: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/aspect: a slope that faces the direction squarely is 1, one a spread away is 0, and between them the mask is the smooth step of the angle', async () => {
  // The defaults: a spread of 60 degrees to either side. The planes are tilted by 30 degrees, above the feather.
  for (const facing of [0, 45, 90, 135, 180, 225, 270, 315, 20, 333]) {
    for (const turn of [0, 15, -30, 45, -59]) {
      const { out } = await renderNode(def, { inputs: { in: plane(30, facing) }, params: { ...RAW, angle: (facing + turn + 360) % 360 } });
      expectStats(out, uniform(ease(1 - Math.abs(turn) / 60)));
    }
    for (const turn of [61, 120, 180, -90]) {
      const { out } = await renderNode(def, { inputs: { in: plane(30, facing) }, params: { ...RAW, angle: (facing + turn + 360) % 360 } });
      expectStats(out, { min: [0, 0], max: [0, 0] });
    }
  }
  // Another spread: 45 degrees off is a quarter of the way out of a spread of 180.
  const wide = await renderNode(def, { inputs: { in: plane(30, 100) }, params: { ...RAW, angle: 145, spread: 180 } });
  expectStats(wide.out, uniform(ease(0.75)));
  // A spread of 0 selects nothing.
  expectStats((await renderNode(def, { inputs: { in: plane(30, 100) }, params: { ...RAW, angle: 100, spread: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/aspect: level ground faces nowhere, and gentle slopes come in over the feather above the lower slope', async () => {
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: RAW })).out, { min: [0, 0], max: [0, 0] });
  // The defaults face 180, which is -X, leave out slopes up to 10 degrees and select in full from 20.
  for (const [tilt, expected] of [[5, 0], [9.9, 0], [12.5, ease(0.25)], [15, 0.5], [17.5, ease(0.75)], [20.5, 1], [60, 1]] as const) {
    const { out } = await renderNode(def, { inputs: { in: plane(tilt, 180) }, params: RAW });
    expectStats(out, expected === 0 || expected === 1 ? { min: [expected, expected], max: [expected, expected] } : uniform(expected));
  }
  // Without a feather the lower slope is a hard edge; from 0 every slope counts.
  const hard = { ...RAW, slopeMin: 25, feather: 0 };
  expectStats((await renderNode(def, { inputs: { in: plane(24.5, 180) }, params: hard })).out, { min: [0, 0], max: [0, 0] });
  expectStats((await renderNode(def, { inputs: { in: plane(25.5, 180) }, params: hard })).out, { min: [1, 1], max: [1, 1] });
  expectStats((await renderNode(def, { inputs: { in: plane(0.5, 180) }, params: { ...RAW, slopeMin: 0, feather: 0 } })).out, { min: [1, 1], max: [1, 1] });
});

test('select/aspect: the lower slope is physical: it follows the height range', async () => {
  // rampX rises towards +X by the height range across the terrain, 14.04 degrees: it faces -X, at 180.
  const params = { ...RAW, angle: 180, slopeMin: 20, feather: 0 };
  expectStats((await renderNode(def, { inputs: { in: 'rampX' }, params })).out, { min: [0, 0], max: [0, 0] });
  // Twice the height range: 26.57 degrees.
  expectStats((await renderNode(def, { inputs: { in: 'rampX' }, params, settings: { heightRange: 2048 } })).out, { min: [1, 1], max: [1, 1] });
});

test('select/aspect: a cone is selected on the side that faces the direction, by the angle around it', async () => {
  // The flank of the cone is at 45 degrees and faces away from its axis. Direction 90 is +Y, down the picture.
  const { out } = await renderNode(def, { inputs: { in: 'cone' }, params: { ...RAW, angle: 90, spread: 90 } });
  let worst = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 66) assert.equal(at(out, x, y), 0, 'the level floor');
      if (r < 12 || r > 60) continue;
      // The direction a texel of the flank faces, measured from +Y. A central difference across the round
      // contours is off by a degree at most this far from the tip.
      const turn = Math.abs(Math.atan2(x - 128, y - 128));
      worst = Math.max(worst, Math.abs(at(out, x, y) - ease(1 - turn / (Math.PI / 2))));
    }
  }
  assert.ok(worst <= 0.02, `the flank differs from the smooth step of its angle by ${worst}`);
  assert.equal(at(out, 128, 168), 1, 'the flank below the tip in the picture faces +Y');
  assert.equal(at(out, 128, 88), 0, 'the flank above it faces -Y');
});

test('select/aspect: the radius smooths before measuring: ripples narrower than it do not turn the slope', async () => {
  // A plane that faces +X at 20 degrees, crossed by ripples 8 texels long that run along x and tilt it by up to 28 degrees to either side.
  const rise = 4 * Math.tan(degrees(20));
  const rippled = fieldOf(257, (u, v) => -rise * u + 0.012 * Math.sin((2 * Math.PI * v * 256) / 8));
  const params = { angle: 0, spread: 30, slopeMin: 0, feather: 0 };
  const raw = (await renderNode(def, { inputs: { in: rippled }, params: { ...params, ...RAW } })).out;
  let turned = 0;
  for (let y = 0; y < 257; y++) if (at(raw, 100, y) === 0) turned++;
  assert.ok(turned > 60, `unsmoothed, ${turned} of 257 texels of a column are turned more than 30 degrees away`);
  // A radius of 16 texels leaves e^-79 of the ripples: the plane faces +X squarely. At the two borders the
  // ripples run into, the Gaussian has one side only and leaves a tenth of them.
  const smooth = (await renderNode(def, { inputs: { in: rippled }, params: { ...params, radius: 16 / 256 } })).out;
  expectStats(smooth, { min: [0.99, 1], max: [1, 1] });
  let inside = 0;
  for (let y = 48; y <= 208; y++) for (let x = 0; x < 257; x++) if (at(smooth, x, y) < 0.9999) inside++;
  assert.equal(inside, 0, 'texels three radii from those borders that are not selected in full');
});

test('select/aspect: inverted, the mask is its complement', async () => {
  const plain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'terrain' }, params: { invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  expectStats(plain, { min: [0, 0], max: [1, 1] });
});

test('select/aspect: two levels of the ladder agree, also where only the finer one smooths on a coarser grid', async () => {
  // At the default radius both levels smooth in one pass: 1.28 texels at 257 and 2.56 at 513.
  const fine = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(fine[257].out, fine[513].out, { rel: 0.01 });
  // A radius of 0.03 is 7.68 texels at 257 and 15.36 at 513, which one pass does not hold.
  const broad = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.03 } });
  expectLadder(broad[257].out, broad[513].out, { rel: 0.01 });
});
