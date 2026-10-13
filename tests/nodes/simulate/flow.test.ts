// tests/nodes/simulate/flow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectFinite, expectIdentical, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import { mixSeed } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/simulate/flow.ts';
import { routeEps } from '../../../src/core/nodes/simulate/_route.ts';
import { adjacent, neighbour, referenceRoute } from './_route-reference.ts';

conformance(def, {
  skip: {
    resolution: 'Both outputs are stream lines one texel wide, which finer detail moves, and the area through a texel of a slope halves with the cell. At shared vertices 257 and 513 differ by 1.0 and 0.7 standard deviations; the test below compares where the water leaves, which agrees within 4 %.',
  },
});

const SEA = 0.25;
/** The test settings: 4096 m across, 1024 m of height range, project seed 1. */
const T = 4096, R = 1024, PROJECT_SEED = 1;
/** The seed the node hands the router at its own seed 0. */
const routerSeed = (seed = 0): number => mixSeed(mixSeed(PROJECT_SEED, seed), 0);
const alone = { precipitation: null } as const;

/** The reference router's result for a field under the test settings. */
function routed(input: FieldData, routing: 'single' | 'multiple', seed = 0, weight?: Float32Array) {
  return referenceRoute({ height: input.data, res: input.width, eps: routeEps(R), seaLevel: SEA, routing, seed: routerSeed(seed), weight });
}

test('simulate/flow: out is the drainage area of the router, with one receiver or with all lower neighbours', async () => {
  for (const routing of ['single', 'multiple'] as const) {
    for (const name of ['terrain', 'cone', 'basin'] as const) {
      const input = fixtures[name](129);
      const { out } = await renderNode(def, { res: 129, inputs: { in: input, ...alone }, params: { routing } });
      const expected = routed(input, routing).area!;
      let apart = 0;
      for (let i = 0; i < expected.length; i++) {
        if (routing === 'single' ? !adjacent(out.data[i]!, expected[i]!) : Math.abs(out.data[i]! - expected[i]!) > 1e-6 * expected[i]!) apart++;
      }
      assert.equal(apart, 0, `${name}, ${routing}: texels whose area is not the reference's`);
    }
  }
});

test('simulate/flow: the area is above 0, never falls from a texel to its receiver, and reaches the outlets whole', async () => {
  for (const name of ['terrain', 'notch', 'bowl'] as const) {
    const input = fixtures[name](257);
    const { out } = await renderNode(def, { inputs: { in: input, ...alone } });
    const reference = routed(input, 'single');
    let sum = 0, falling = 0, without = 0;
    for (let i = 0; i < out.data.length; i++) {
      if (reference.outlet[i]) { sum += out.data[i]!; continue; }
      const k = reference.receiver[i]!;
      if (k === 4) without++;
      else if (out.data[neighbour(i, k, 257)]! < out.data[i]!) falling++;
    }
    assert.ok(stats(out).min >= Math.fround(1 / (257 * 257)), `${name}: the smallest area is ${stats(out).min}, less than one texel`);
    assert.ok(stats(out).max <= 1, `${name}: the largest area is ${stats(out).max}`);
    assert.equal(without, 0, `${name}: texels that are no outlet and drain nowhere`);
    assert.equal(falling, 0, `${name}: receivers with less area than their donor`);
    assert.ok(Math.abs(sum - 1) < 1e-4, `${name}: the outlets hold ${sum} of the terrain`);
  }
});

test('simulate/flow: on a plane every texel drains the row above it, and the wetness is the logarithm of that area per metre of contour over the slope', async () => {
  // rampX rises towards +x by 0.25 m/m: a texel has one lower neighbour, the one towards -x, so the texel in
  // column x drains the columns x to 255 of its row; column 256 is the border, an outlet. Without a sea: the
  // ramp starts at height 0.
  const { out, wetness } = await renderNode(def, { inputs: { in: 'rampX', ...alone }, settings: { seaLevel: -1 } });
  const n = 257 * 257;
  const interior = (f: FieldData, fn: (x: number) => number): FieldData =>
    fieldOf(257, (u, v) => { const x = Math.round(u * 256), y = Math.round(v * 256); return y === 0 || y === 256 || x === 0 || x === 256 ? at(f, x, y) : fn(x); });
  expectClose(out, interior(out, (x) => (256 - x) / n), { max: 1e-9 });
  assert.ok(Math.abs(at(out, 0, 100) - 256 / n) < 1e-9, 'the border texel of a row holds the whole row but its last texel');
  expectClose(wetness, interior(wetness, (x) => Math.log((((256 - x) / n) * T * T) / 16 / 0.25)), { max: 1e-4 });
});

test('simulate/flow: wetness is ln(area per metre of contour / slope) at every texel, with the slope of the terrain itself', async () => {
  const input = fixtures.terrain(257);
  const { out, wetness } = await renderNode(def, { inputs: { in: input, ...alone } });
  let worst = 0;
  for (let y = 1; y < 256; y++) {
    for (let x = 1; x < 256; x++) {
      const gx = (0.5 * (at(input, x + 1, y) - at(input, x - 1, y)) * R) / 16, gy = (0.5 * (at(input, x, y + 1) - at(input, x, y - 1)) * R) / 16;
      const expected = Math.log(((at(out, x, y) * T * T) / 16) / Math.max(Math.hypot(gx, gy), 0.001));
      worst = Math.max(worst, Math.abs(at(wetness, x, y) - expected));
    }
  }
  assert.ok(worst < 2e-3, `wetness is off by ${worst} at the most`);
  // Valley floors are wetter than ridges: the wettest hundredth lies where much area gathers.
  const s = stats(wetness);
  assert.ok(s.p99 - s.p50 > 3, `the wettest texels stand ${s.p99 - s.p50} above the median`);
});

test('simulate/flow: a channel gathers the water of its banks', async () => {
  // The notch fixture: a plane that falls towards +x with a V-shaped channel along v = 0.5, 0.1 wide to each
  // side. Its banks fall towards the centre line as fast as the plane falls along it, so the strip
  // |v - 0.5| < 0.1 drains into the channel but for the corner next to the border: 0.19 of the terrain.
  // Without a sea: the mouth of the channel lies below the test sea level.
  const { out, wetness } = await renderNode(def, { inputs: { in: 'notch', ...alone }, settings: { seaLevel: -1 } });
  let through = 0;
  for (let y = 128 - 3; y <= 128 + 3; y++) through += at(out, 256, y);
  assert.ok(through > 0.17 && through < 0.2, `${through} of the terrain leaves through the mouth of the channel`);
  // Beside the notch the plane drains straight to the border: no texel there holds more than its row.
  let beside = 0;
  for (let y = 0; y < 90; y++) for (let x = 0; x < 257; x++) beside = Math.max(beside, at(out, x, y));
  assert.ok(beside <= 257 / (257 * 257) + 1e-9, `on the plane the largest area is ${beside}`);
  assert.ok(at(wetness, 200, 128) > at(wetness, 200, 40) + 3, 'the channel is wetter than the plane');
});

test('simulate/flow: multiple routing spreads the water that single routing gathers into lines', async () => {
  // On the flank of the cone a single receiver draws streams; shared among the lower neighbours the water fans out.
  const single = await renderNode(def, { inputs: { in: 'cone', ...alone }, settings: { seaLevel: -1 } });
  const multiple = await renderNode(def, { inputs: { in: 'cone', ...alone }, params: { routing: 'multiple' }, settings: { seaLevel: -1 } });
  let most = [0, 0], sum = 0;
  for (let y = 80; y < 177; y++) for (let x = 80; x < 177; x++) most = [Math.max(most[0]!, at(single.out, x, y)), Math.max(most[1]!, at(multiple.out, x, y))];
  for (let i = 0; i < 257; i++) sum += at(multiple.out, i, 0) + at(multiple.out, i, 256) + (i > 0 && i < 256 ? at(multiple.out, 0, i) + at(multiple.out, 256, i) : 0);
  assert.ok(most[1]! < 0.3 * most[0]!, `the largest area on the flank is ${most[1]} with multiple receivers and ${most[0]} with one`);
  assert.ok(Math.abs(sum - 1) < 1e-4, `the border holds ${sum} of the terrain`);
  // Where a texel has one lower neighbour the two are the same thing.
  const a = await renderNode(def, { inputs: { in: 'rampX', ...alone }, wants: ['out'] });
  const b = await renderNode(def, { inputs: { in: 'rampX', ...alone }, params: { routing: 'multiple' }, wants: ['out'] });
  assert.ok(stats(a.out).max > 100 / (257 * 257), 'the ramp gathers rows of texels');
  expectClose(a.out, b.out, { max: 1e-9 });
});

test('simulate/flow: the seed moves the small streams and leaves the totals', async () => {
  const input = fixtures.terrain(257);
  const a = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 1 }, wants: ['out'] });
  const b = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 2 }, wants: ['out'] });
  let differing = 0;
  for (let i = 0; i < a.out.data.length; i++) if (a.out.data[i] !== b.out.data[i]) differing++;
  assert.ok(differing > 0.2 * a.out.data.length, `${differing} texels differ between two seeds`);
  // The largest stream of the terrain is the same river whatever the seed.
  assert.ok(Math.abs(stats(a.out).max - stats(b.out).max) < 0.1 * stats(a.out).max, `the largest areas are ${stats(a.out).max} and ${stats(b.out).max}`);
  // With multiple receivers nothing is drawn: the seed changes nothing.
  const c = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 1, routing: 'multiple' } });
  const d = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 2, routing: 'multiple' } });
  expectIdentical(c.out, d.out);
  expectIdentical(c.wetness, d.wetness);
});

test('simulate/flow: precipitation weighs what each texel contributes', async () => {
  const input = fixtures.terrain(257);
  const plain = await renderNode(def, { inputs: { in: input, ...alone } });
  // Rain everywhere is no weight at all.
  const everywhere = await renderNode(def, { inputs: { in: input, precipitation: 'one' } });
  expectIdentical(everywhere.out, plain.out);
  expectIdentical(everywhere.wetness, plain.wetness);
  // Rain on the disc of the mask fixture: the outlets hold the mean of the mask, and no texel more than without it.
  const disc = await renderNode(def, { inputs: { in: input, precipitation: 'mask' } });
  const reference = routed(input, 'single', 0, fixtures.mask(257).data);
  let sum = 0, more = 0, falling = 0;
  for (let i = 0; i < disc.out.data.length; i++) {
    if (disc.out.data[i]! > plain.out.data[i]! * (1 + 1e-6)) more++;
    if (reference.outlet[i]) sum += disc.out.data[i]!;
    else if (disc.out.data[neighbour(i, reference.receiver[i]!, 257)]! < disc.out.data[i]!) falling++;
  }
  assert.ok(Math.abs(sum - stats(fixtures.mask(257)).mean) < 1e-4, `the outlets hold ${sum}; the mask covers ${stats(fixtures.mask(257)).mean}`);
  assert.equal(more, 0, 'texels that drain more with less rain');
  assert.equal(falling, 0, 'the weighted area never falls along a receiver');
  expectStats(disc.out, { min: [0, 0] });
  // No rain at all: no area anywhere, and the wetness stays a number.
  const none = await renderNode(def, { inputs: { in: input, precipitation: 'zero' } });
  expectStats(none.out, { min: [0, 0], max: [0, 0] });
  expectFinite(none.wetness);
  // A mask is read saturated: a precipitation of 3 is one of 1, and one below 0 is none.
  const heavy = await renderNode(def, { inputs: { in: input, precipitation: fieldOf(257, () => 3) }, wants: ['out'] });
  expectIdentical(heavy.out, plain.out);
  const negative = await renderNode(def, { inputs: { in: input, precipitation: fieldOf(257, () => -2) }, wants: ['out'] });
  expectStats(negative.out, { min: [0, 0], max: [0, 0] });
});

test('simulate/flow: between two levels of the ladder the stream lines move, and the water leaves the terrain at the same places', async () => {
  // What leaves through each of 8 x 8 blocks of the terrain, by its border texels and the texels under the sea.
  const leaving = (out: FieldData, input: FieldData): number[] => {
    const res = out.width, blocks = new Array<number>(64).fill(0);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        if (x > 0 && y > 0 && x < res - 1 && y < res - 1 && at(input, x, y) > SEA) continue;
        blocks[Math.min(7, Math.floor((8 * y) / res)) * 8 + Math.min(7, Math.floor((8 * x) / res))]! += at(out, x, y);
      }
    }
    return blocks;
  };
  const levels = await renderLadder(def, { inputs: { in: 'terrain', ...alone }, wants: ['out'] });
  const coarse = leaving(levels[257]!.out!, fixtures.terrain(257)), fine = leaving(levels[513]!.out!, fixtures.terrain(513));
  let apart = 0;
  for (let i = 0; i < 64; i++) apart += Math.abs(coarse[i]! - fine[i]!);
  assert.ok(apart < 0.06, `${apart} of the terrain leaves through another block at 513 than at 257`);
  assert.ok(Math.max(...coarse) > 0.05, 'the terrain has rivers: one block takes more than a twentieth of it');
});
