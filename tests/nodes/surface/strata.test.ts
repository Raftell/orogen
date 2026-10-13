// tests/nodes/surface/strata.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import { hashCell, hashUnit } from '../../../src/core/api.ts';
import def, { STRATA } from '../../../src/core/nodes/surface/strata.ts';
import { bedOf, mapField, seedFor } from './_probe.ts';

conformance(def, {
  resolutionTol: {
    value: 0.02,
    reason: 'A cliff that would be narrower than 2 texels is drawn that wide, so a finer level draws it steeper: 1.3 % from 257 to 513 on slopes up to 55 degrees, 0.1 % from 513 to 1025, and 0.1 % with beds of 0.3.',
  },
});

const N = 257;
const L = N - 1;
/** Level beds without folds, laid on the terrain itself, and shown on every slope above 1 degree in full from 16. */
const PLAIN = { tilt: 0, warpStrength: 0, radius: 0.0001, slopeMin: 1 };
/** With this height range rampX and rampY climb at 26.6 degrees: steeper than the 16 at which the beds show in full. */
const STEEP = { heightRange: 2048 };

/** What the node adds to a terrain. */
const raised = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));

/** The raise on the CPU, for the level `s` in beds that changes by `g` a texel: in beds. */
function stood(s: number, g: number, seed: number): number {
  const bed = bedOf(s, STRATA.uneven, seed);
  const own = bed.hi - bed.lo;
  const t = Math.min(Math.max((s - bed.lo) / own, 0), 1);
  const hard = hashUnit(hashCell(bed.index, 1, seed));
  const stand = STRATA.softest + (1 - STRATA.softest) * hard;
  const cliff = Math.min(Math.max((STRATA.cliffTexels * g) / own, STRATA.cliff), 1);
  const level = t < cliff ? (1 + ((1 - cliff) * stand) / cliff) * t : 1 - (1 - stand) * (1 - t);
  return own * (level - t);
}

test('surface/strata: on an even slope every bed is a cliff under a bench, as far out as its hardness lets it stand', async () => {
  for (const [thickness, seed] of [[0.1, 0], [0.04, 7], [0.3, 2]] as const) {
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { ...PLAIN, thickness, seed }, settings: STEEP });
    const f = Math.fround(thickness);
    const reference = mapField(out, (_, x) => Math.fround(x / L) + f * stood(Math.fround(x / L) / f, 1 / L / f, seedFor(0, seed)));
    expectClose(out, reference, { max: 2e-5 });
  }
});

test('surface/strata: the ground is only raised, by less than a bed is thick, and the beds differ in hardness', async () => {
  const src = await fixtures.fbm(N);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { thickness: 0.1 } });
  const lift = stats(raised(out, src));
  // The thickest bed is 1.8 thicknesses, and the bench of the hardest stands out by its part above the cliff.
  assert.ok(lift.min >= -1e-6 && lift.max <= 0.1 * 1.8 * (1 - STRATA.cliff) + 1e-6, `the terrain is raised by ${lift.min} to ${lift.max}`);
  assert.ok(lift.mean > 0.004, `the mean raise is ${lift.mean}`);

  // On the even slope: how far each bed stands out at the top of its cliff, as a part of its thickness.
  const thickness = 0.05, seed = seedFor(0);
  const ramp = await renderNode(def, { inputs: { in: 'rampX' }, params: { ...PLAIN, thickness }, settings: STEEP });
  const most = new Map<number, number>();
  for (let x = 0; x < N; x++) {
    const bed = bedOf(Math.fround(x / L) / Math.fround(thickness), STRATA.uneven, seed);
    const part = (at(ramp.out, x, 9) - x / L) / (thickness * (bed.hi - bed.lo));
    most.set(bed.index, Math.max(most.get(bed.index) ?? 0, part));
  }
  const parts = [...most.values()].slice(1, -1);      // the first and the last bed are cut by the border
  assert.ok(parts.length >= 15, `${parts.length} whole beds on the ramp`);
  assert.ok(Math.max(...parts) > 3 * Math.min(...parts), `the hardest bed stands out by ${Math.max(...parts)} of its thickness and the softest by ${Math.min(...parts)}`);
  assert.ok(Math.max(...parts) <= 1 - STRATA.cliff + 1e-4);
});

test('surface/strata: gentle ground stays as it is, and the beds show in full a little above the lower slope', async () => {
  // The notch is nowhere steeper than 10.1 degrees.
  const gentle = await renderNode(def, { inputs: { in: 'notch' }, params: { slopeMin: 15 } });
  expectIdentical(gentle.out, fixtures.notch(N));
  // The cone: a flank of 45 degrees on a level floor.
  const cone = fixtures.cone(N);
  const { out } = await renderNode(def, { inputs: { in: cone }, params: { slopeMin: 15, thickness: 0.1, radius: 0.0001 } });
  const lift = raised(out, cone);
  let floor = 0, flank = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 70) floor = Math.max(floor, Math.abs(at(lift, x, y)));
      else if (r > 6 && r < 58) flank = Math.max(flank, at(lift, x, y));
    }
  }
  assert.equal(floor, 0, 'the level floor around the cone');
  assert.ok(flank > 0.02, `the flank is raised by up to ${flank}`);
  // A lower slope above the flank's: nothing shows.
  const none = await renderNode(def, { inputs: { in: cone }, params: { slopeMin: 50, radius: 0.0001 } });
  expectIdentical(none.out, cone);
});

test('surface/strata: tilted beds are planes that fall towards the dip, and ground that falls with them lies in one bed', async () => {
  // With the steep height range a tilt of atan(1/2) is a fall of one height per terrain width. rampX rises one
  // height per width along x; beds that dip towards +Y cross it on the diagonals x + y = const.
  const tilt = (Math.atan(0.5) * 180) / Math.PI;
  const ramp = fixtures.rampX(N);
  const across = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, tilt, angle: 90, thickness: 0.08 }, settings: STEEP });
  const lift = raised(across.out, ramp);
  let alongBed = 0, alongRow = 0;
  for (let y = 1; y < N; y++) {
    for (let x = 0; x < N - 1; x++) {
      alongBed = Math.max(alongBed, Math.abs(at(lift, x, y) - at(lift, x + 1, y - 1)));
      alongRow = Math.max(alongRow, Math.abs(at(lift, x, y) - at(lift, x, y - 1)));
    }
  }
  assert.ok(alongBed < 2e-5, `along a bed the raise changes by ${alongBed}`);
  assert.ok(alongRow > 0.005, `from one row to the next it changes by up to ${alongRow}`);

  // Beds that dip towards -X fall as the ramp does: the whole ramp is the top of one bed, raised evenly.
  const withIt = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, tilt, angle: 180, thickness: 0.08 }, settings: STEEP });
  const even = stats(raised(withIt.out, ramp));
  assert.ok(even.max - even.min < 2e-5, `a ramp that falls with the beds is raised by ${even.min} to ${even.max}`);
  // And beds that dip towards +X cross it twice as often as level ones.
  const cliffs = (f: FieldData): number => {
    let count = 0;
    for (let x = 1; x < N - 1; x++) if (at(f, x, 5) > at(f, x - 1, 5) + 1e-6 && at(f, x, 5) >= at(f, x + 1, 5)) count++;
    return count;
  };
  const level = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.08 }, settings: STEEP });
  const against = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, tilt, angle: 0, thickness: 0.08 }, settings: STEEP });
  const few = cliffs(raised(level.out, ramp)), many = cliffs(raised(against.out, ramp));
  assert.ok(few >= 10 && few <= 14, `${few} beds of 0.08 on a ramp one height high`);
  assert.ok(many >= 2 * few - 3 && many <= 2 * few + 3, `${many} beds where the pile rises twice as fast, ${few} where it is level`);
});

test('surface/strata: the warp folds the beds, and another seed is another pile of beds', async () => {
  const ramp = fixtures.rampX(N);
  // Level beds cross rampX along its columns.
  const bends = (f: FieldData): number => {
    let most = 0;
    for (let x = 0; x < N; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < N; y++) {
        lo = Math.min(lo, at(f, x, y));
        hi = Math.max(hi, at(f, x, y));
      }
      most = Math.max(most, hi - lo);
    }
    return most;
  };
  const straight = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.08 }, settings: STEEP });
  assert.ok(bends(straight.out) < 1e-6, `without a warp a column of the ramp varies by ${bends(straight.out)}`);
  const folded = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.08, warpStrength: 1, warpSize: 0.2 }, settings: STEEP });
  assert.ok(bends(folded.out) > 0.02, `folded, it varies by ${bends(folded.out)}`);
  const other = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.08, seed: 1 }, settings: STEEP });
  assert.ok(stats(raised(other.out, straight.out)).std > 0.003, 'the beds of another seed lie elsewhere');
});

test('surface/strata: a cliff is never narrower than the grid can draw, and beds too thin for it leave the terrain as it is', async () => {
  // Beds of 0.02 on a ramp of one height: 5 texels each, of which the cliff takes 2 where it would take 1.25.
  const ramp = fixtures.rampX(N);
  const thin = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.02 }, settings: STEEP });
  const lift = raised(thin.out, ramp);
  let rise = 0;
  for (let x = 0; x < N - 1; x++) rise = Math.max(rise, at(lift, x + 1, 3) - at(lift, x, 3));
  // The most a cliff gains on the ramp in one texel: what its bed stands out, over 2 texels.
  assert.ok(rise <= (0.02 * 1.8) / STRATA.cliffTexels + 1e-6, `the steepest cliff rises ${rise} a texel above the ramp`);
  // Beds of 0.004 are one texel each: nothing is drawn.
  const none = await renderNode(def, { inputs: { in: ramp }, params: { ...PLAIN, thickness: 0.004 }, settings: STEEP });
  expectClose(none.out, ramp, { max: 1e-6 });
});

test('surface/strata: no strength gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { strength: 0 } });
  expectIdentical(outputs.out, src);
  assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
});

test('surface/strata: the beds are the same at two levels of the ladder wherever both can draw the cliffs', async () => {
  // Beds of 0.3: on the terrain fixture a cliff of a quarter of one is 3 texels wide or more at 257.
  const thick = await renderLadder(def, { inputs: { in: 'terrain' }, params: { thickness: 0.3 } });
  expectLadder(thick[257]!.out, thick[513]!.out, { rel: 0.004 });
  const thin = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(thin[257]!.out, thin[513]!.out, { rel: 0.02 });
});
