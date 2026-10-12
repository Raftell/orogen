// tests/nodes/ref/slope-mask.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, type FieldData } from '../../helpers/index.ts';
import fbm from '../../../src/core/nodes/ref/fbm.ts';
import def from '../../../src/core/nodes/ref/slope-mask.ts';

/** What two levels of the ladder may differ by, as a part of the standard deviation: the default is 0.01. */
const LADDER_TOLERANCE = 0.08;

conformance(def, {
  resolutionTol: {
    value: LADDER_TOLERANCE,
    reason: 'Measures slope: a finer level resolves steeper faces of the same terrain. On detail down to 8 cells of the coarser level the mask differs by 5.6 % of its standard deviation; the test below measures it.',
  },
});

const degrees = (angle: number): number => (angle * Math.PI) / 180;

/**
 * A plane that rises at `tilt` degrees in the direction `towards`. With the test settings a height of 1 is
 * 1024 m and the terrain is 4096 m wide, so a rise of k across the terrain is a slope of k / 4.
 */
function plane(tilt: number, towards: number): FieldData {
  const rise = 4 * Math.tan(degrees(tilt));
  return fieldOf(257, (u, v) => rise * (u * Math.cos(degrees(towards)) + v * Math.sin(degrees(towards))));
}

test('ref/slope-mask: a plane below the lower angle is 0 and one above the upper angle is 1, exactly', async () => {
  // The defaults select from 20 to 45 degrees. The tilts stay a degree away from them: the slope is measured in float32.
  for (const towards of [0, 90, 215]) {
    expectStats((await renderNode(def, { inputs: { in: plane(19, towards) } })).out, { min: [0, 0], max: [0, 0] });
    expectStats((await renderNode(def, { inputs: { in: plane(46, towards) } })).out, { min: [1, 1], max: [1, 1] });
  }
  expectStats((await renderNode(def, { inputs: { in: 'zero' } })).out, { min: [0, 0], max: [0, 0] });
});

test('ref/slope-mask: between the two angles the mask is linear in the angle, whichever way the slope faces', async () => {
  for (const [tilt, towards] of [[25, 0], [32.5, 90], [32.5, 140], [40, 300]] as const) {
    const { out } = await renderNode(def, { inputs: { in: plane(tilt, towards) } });
    const expected = (tilt - 20) / 25;
    expectStats(out, { min: [expected - 1e-4, expected + 1e-4], max: [expected - 1e-4, expected + 1e-4] });
  }
  // Other thresholds: 30 degrees is three quarters of the way from 0 to 40.
  const wide = await renderNode(def, { inputs: { in: plane(30, 60) }, params: { slopeMin: 0, slopeMax: 40 } });
  expectStats(wide.out, { min: [0.75 - 1e-4, 0.75 + 1e-4], max: [0.75 - 1e-4, 0.75 + 1e-4] });
});

test('ref/slope-mask: slopes are physical: they follow the height range and the terrain size', async () => {
  // rampX rises by the height range across the terrain: 14.04 degrees with the test settings, below the lower angle.
  expectStats((await renderNode(def, { inputs: { in: 'rampX' } })).out, { min: [0, 0], max: [0, 0] });
  // Twice the height range: atan(1 / 2) is 26.57 degrees.
  const expected = (Math.atan(0.5) * 180 / Math.PI - 20) / 25;
  const tall = await renderNode(def, { inputs: { in: 'rampX' }, settings: { heightRange: 2048 } });
  expectStats(tall.out, { min: [expected - 1e-4, expected + 1e-4], max: [expected - 1e-4, expected + 1e-4] });
  // Twice the height range on twice the width is the same slope everywhere.
  const base = await renderNode(def, { inputs: { in: 'terrain' } });
  const scaled = await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 8192, heightRange: 2048 } });
  expectClose(scaled.out, base.out, { max: 1e-6 });
});

test('ref/slope-mask: an upper angle at or below the lower one gives a hard edge at the lower', async () => {
  for (const slopeMax of [30, 10]) {
    expectStats((await renderNode(def, { inputs: { in: plane(29, 45) }, params: { slopeMin: 30, slopeMax } })).out, { min: [0, 0], max: [0, 0] });
    expectStats((await renderNode(def, { inputs: { in: plane(31, 45) }, params: { slopeMin: 30, slopeMax } })).out, { min: [1, 1], max: [1, 1] });
  }
});

test('ref/slope-mask: a cone is selected on its flank and not on its floor', async () => {
  // The cone rises from a radius of 64 texels to its tip at the centre. Its flank is at 45 degrees with the test
  // settings, the upper angle of the defaults; a central difference across its round contours measures a little less.
  const { out } = await renderNode(def, { inputs: { in: 'cone' } });
  let pale = 0, lit = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      // Away from the tip and the foot, where a difference straddles the change of slope.
      const r = Math.hypot(x - 128, y - 128);
      if (r > 8 && r < 62 && at(out, x, y) < 0.99) pale++;
      if (r > 66 && at(out, x, y) !== 0) lit++;
    }
  }
  assert.equal(pale, 0, 'texels of the flank below 0.99');
  assert.equal(lit, 0, 'texels of the floor above 0');
});

test('ref/slope-mask: the declared tolerance is what detail of 8 cells needs, and the smooth fixture needs none', async () => {
  // Four octaves at the default size: the finest wavelength is 8 cells at 257 and 16 at 513, where a central
  // difference keeps 90 % and 97 % of its slope.
  const levels: FieldData[] = [];
  for (const res of [257, 513]) {
    const { out: terrain } = await renderNode(fbm, { res, params: { octaves: 4 } });
    levels.push((await renderNode(def, { res, inputs: { in: terrain } })).out);
  }
  const rough = expectLadder(levels[0], levels[1], { rel: LADDER_TOLERANCE });
  assert.ok(rough.rel > 0.03, `on detail of 8 cells the levels differ by ${rough.rel} of the standard deviation: the tolerance is not there for nothing`);
  // The fixture of the conformance suite has no wavelength below 22 cells at 257.
  const smooth = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(smooth[257].out, smooth[513].out, { rel: 0.01 });
});
