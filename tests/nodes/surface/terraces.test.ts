// tests/nodes/surface/terraces.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def, { TERRACES } from '../../../src/core/nodes/surface/terraces.ts';
import { bedBase, bedOf, levelShare, mapField, seedFor, steepest } from './_probe.ts';

conformance(def, {
  resolutionTol: {
    value: 0.03,
    reason: 'A riser that would be narrower than 2.5 texels is drawn that wide, so a finer level draws it steeper: 2.1 % from 257 to 513 on slopes up to 55 degrees, 0.03 % from 513 to 1025, none at a sharpness of 0.5.',
  },
});

const N = 257;
const L = N - 1;
/** No smoothing: below a quarter of a texel the steps follow the terrain's own contour lines. */
const UNSMOOTHED = { radius: 0.0001 };
/** A height range in which the ramps are all but level, so that no edge strays: only the steps are left. */
const NO_STRAY = { heightRange: 1 };

/**
 * The steps on the CPU, without the noise: the level `s`, in beds, to the stepped level. `g` is how far the level
 * changes from one texel to the next.
 */
function stepped(s: number, g: number, sharpness: number, irregularity: number, seed: number): number {
  const bed = bedOf(s, irregularity, seed);
  const mid = 0.5 * (bed.lo + bed.hi), own = bed.hi - bed.lo;
  if (s < mid) {
    const below = bed.lo - bedBase(bed.index - 1, irregularity, seed);
    const riser = Math.min(Math.max(1 - sharpness, (TERRACES.riserTexels * g) / (0.5 * (own + below)), 1e-4), 1);
    return Math.min(bed.lo + (s - bed.lo) / riser, mid);
  }
  const above = bedBase(bed.index + 2, irregularity, seed) - bed.hi;
  const riser = Math.min(Math.max(1 - sharpness, (TERRACES.riserTexels * g) / (0.5 * (own + above)), 1e-4), 1);
  return Math.max(bed.hi - (bed.hi - s) / riser, mid);
}

test('surface/terraces: a ramp becomes level benches at the middle heights of its beds, joined by risers of one steepness', async () => {
  // Even beds first: four steps of a quarter each. Half of each step is bench and half riser, twice as steep as the ramp.
  const even = await renderNode(def, { inputs: { in: 'rampX' }, params: { levels: 4, sharpness: 0.5, irregularity: 0, ...UNSMOOTHED } });
  for (const [x, expected] of [[32, 0.125], [16, 0.125], [8, 0.0625], [56, 0.1875], [64, 0.25], [96, 0.375], [200, 0.8125], [224, 0.875], [256, 1]] as const) {
    assert.ok(Math.abs(at(even.out, x, 100) - expected) < 1e-6, `at texel ${x} the ramp is stepped to ${at(even.out, x, 100)}; ${expected} by hand`);
  }
  // Uneven beds: against the steps computed on the CPU from the hashed bases of the beds.
  for (const [levels, sharpness, seed] of [[6, 0.7, 3], [13, 0.9, 0], [3, 0.25, 11]] as const) {
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { levels, sharpness, irregularity: 1, seed, ...UNSMOOTHED }, settings: NO_STRAY });
    const reference = mapField(out, (_, x) => stepped(Math.fround(x / L) * levels, levels / L, sharpness, 1, seedFor(0, seed)) / levels);
    expectClose(out, reference, { max: 2e-5 });
  }
});

test('surface/terraces: the benches are level, and take the part of every step that the sharpness gives them', async () => {
  for (const sharpness of [0.3, 0.6, 0.9]) {
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { levels: 5, sharpness, irregularity: 0, ...UNSMOOTHED } });
    // On a ramp a part of the height is the same part of the ground. A bench ends between two texels: 5 steps, 10 ends.
    const level = levelShare(out, 1e-7);
    assert.ok(Math.abs(level - sharpness) < 0.05, `at a sharpness of ${sharpness}, ${level} of the ramp is level`);
  }
  // On a terrain: most of the ground is bench, each bench at one height, and there are no more heights than steps.
  const src = await fixtures.fbm(N);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { levels: 6, sharpness: 0.9 } });
  assert.ok(levelShare(out, 1e-7) > 0.35, `${levelShare(out, 1e-7)} of a fractal terrain is level bench`);
  const heights = new Set<number>();
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const v = at(out, x, y);
      if (at(out, x - 1, y) === v && at(out, x + 1, y) === v && at(out, x, y - 1) === v && at(out, x, y + 1) === v) heights.add(v);
    }
  }
  const range = stats(src);
  assert.ok(heights.size >= 4 && heights.size <= Math.ceil((range.max - range.min) * 6) + 2, `${heights.size} bench heights between ${range.min} and ${range.max}`);
});

test('surface/terraces: the irregularity makes the steps uneven in height, and none thinner than a fifth of an even one', async () => {
  const benches = async (irregularity: number): Promise<number[]> => {
    const { out } = await renderNode(def, { res: 513, inputs: { in: 'rampX' }, params: { levels: 12, sharpness: 0.8, irregularity, seed: 5, ...UNSMOOTHED }, settings: NO_STRAY });
    const found: number[] = [];
    for (let x = 1; x < 512; x++) {
      const v = at(out, x, 7);
      if (at(out, x - 1, 7) === v && at(out, x + 1, 7) === v && found.at(-1) !== v) found.push(v);
    }
    return found;
  };
  const even = await benches(0);
  assert.equal(even.length, 12);
  even.forEach((height, k) => assert.ok(Math.abs(height - (k + 0.5) / 12) < 1e-6, `bench ${k} of even steps lies at ${height}`));
  const uneven = await benches(1);
  assert.equal(uneven.length, 12);
  const rises = uneven.slice(1).map((height, k) => (height - uneven[k]!) * 12);
  // The bench of a bed is at its middle: two benches are half of each of their beds apart, and a bed is 0.2 to 1.8 thick.
  assert.ok(Math.min(...rises) >= 0.2 - 1e-4 && Math.max(...rises) <= 1.8 + 1e-4, `the rises are ${rises.map((r) => r.toFixed(2)).join(' ')} steps`);
  assert.ok(Math.max(...rises) - Math.min(...rises) > 0.4, `the rises differ by ${Math.max(...rises) - Math.min(...rises)} of a step`);
  // They are the middles of the hashed beds.
  uneven.forEach((height, k) => {
    const mid = 0.5 * (bedBase(k, 1, seedFor(0, 5)) + bedBase(k + 1, 1, seedFor(0, 5))) / 12;
    assert.ok(Math.abs(height - mid) < 1e-6, `bench ${k} lies at ${height}; the middle of its bed is ${mid}`);
  });
});

test('surface/terraces: a riser is never narrower than the grid can draw, and ground too steep for steps stays as it is', async () => {
  // Twice the height range across the terrain in 32 steps: a step every 8 texels, and its riser 2.5 texels wide
  // at full sharpness, where a hard step would rise a whole step from one texel to the next.
  const steep = fieldOf(N, (u) => 2 * u);
  const { out } = await renderNode(def, { inputs: { in: steep }, params: { levels: 16, sharpness: 1, irregularity: 0, ...UNSMOOTHED } });
  const rise = steepest(out);
  assert.ok(rise <= (1 / 16 / TERRACES.riserTexels) * 1.001, `the steepest riser climbs ${rise} a texel; a step of ${1 / 16} over ${TERRACES.riserTexels} texels is ${1 / 16 / TERRACES.riserTexels}`);
  assert.ok(rise >= (1 / 16 / TERRACES.riserTexels) * 0.999);
  // Of the 8 texels of a step 3 lie on the riser, and 3 of the 5 on the bench have all four neighbours on it.
  assert.ok(Math.abs(levelShare(out, 1e-7) - 3 / 8) < 0.02, `${levelShare(out, 1e-7)} of the ramp is level bench`);
  // Twenty times that: a step is shorter than a riser may be, and nothing is stepped.
  const cliff = fieldOf(N, (u, v) => 40 * u + 0.01 * Math.sin(40 * v));
  const left = await renderNode(def, { inputs: { in: cliff }, params: { levels: 16, sharpness: 1, ...UNSMOOTHED } });
  expectClose(left.out, cliff, { max: 2e-5 });
});

test('surface/terraces: the edges of the benches stray from the contour lines on a slope, and level ground is not broken up', async () => {
  // The contour lines of rampY are its rows.
  const along = (f: FieldData): number => {
    let most = 0;
    for (let y = 0; y < N; y++) {
      let lo = Infinity, hi = -Infinity;
      for (let x = 0; x < N; x++) {
        lo = Math.min(lo, at(f, x, y));
        hi = Math.max(hi, at(f, x, y));
      }
      most = Math.max(most, hi - lo);
    }
    return most;
  };
  const straight = await renderNode(def, { inputs: { in: 'rampY' }, params: { levels: 6, irregularity: 0 } });
  assert.ok(along(straight.out) < 5e-5, `without irregularity a row of the stepped ramp varies by ${along(straight.out)}`);
  const strayed = await renderNode(def, { inputs: { in: 'rampY' }, params: { levels: 6, irregularity: 1, size: 0.2 } });
  assert.ok(along(strayed.out) > 0.5 / 6, `with it a row crosses from one bench to the next: it varies by ${along(strayed.out)}`);
  assert.ok(levelShare(strayed.out, 1e-7) > 0.5, 'and the benches are still level');
  // Another seed strays elsewhere.
  const other = await renderNode(def, { inputs: { in: 'rampY' }, params: { levels: 6, irregularity: 1, size: 0.2, seed: 1 } });
  assert.ok(stats(mapField(other.out, (v, x, y) => v - at(strayed.out, x, y))).std > 0.01);

  // Level ground at the height of a step: the noise would lift patches of it onto the next bench.
  for (const height of [0, 0.25, 0.5 - 1e-4, 0.62]) {
    const flat = fieldOf(N, () => height);
    const { out } = await renderNode(def, { inputs: { in: flat }, params: { levels: 4, irregularity: 1, size: 0.1 } });
    const s = stats(out);
    assert.ok(s.max - s.min < 1e-6, `level ground at ${height} comes out between ${s.min} and ${s.max}`);
  }
});

test('surface/terraces: the smoothing draws the steps along the contour lines of the broad shape, and keeps the benches level', async () => {
  const src = await fixtures.fbm(N);
  // How much of the terrain lies on a riser's edge: the fewer texels, the shorter and straighter the edges.
  const edges = (f: FieldData): number => 1 - levelShare(f, 1e-7);
  const ragged = await renderNode(def, { inputs: { in: src }, params: { levels: 6, sharpness: 0.9, ...UNSMOOTHED } });
  const clean = await renderNode(def, { inputs: { in: src }, params: { levels: 6, sharpness: 0.9, radius: 0.02 } });
  assert.ok(edges(clean.out) < 0.8 * edges(ragged.out), `${edges(clean.out)} of the terrain is off a bench with a wide smoothing and ${edges(ragged.out)} with none`);
});

test('surface/terraces: no sharpness gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { sharpness: 0 } });
  expectIdentical(outputs.out, src);
  assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
});

test('surface/terraces: the steps are the same at two levels of the ladder wherever both can draw the risers', async () => {
  // At a sharpness of 0.5 a riser of the terrain fixture is 5 texels wide or more at 257: both levels draw it as it is.
  const gentle = await renderLadder(def, { inputs: { in: 'terrain' }, params: { levels: 6, sharpness: 0.5 } });
  expectLadder(gentle[257]!.out, gentle[513]!.out, { rel: 0.002 });
  // At the defaults the coarser level widens the risers of its steepest ground to 2.5 texels, and the two differ there.
  const sharp = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(sharp[257]!.out, sharp[513]!.out, { rel: 0.03 });
});
