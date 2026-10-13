// tests/nodes/simulate/fluvial-erosion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectLadder, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import { mixSeed } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/simulate/fluvial-erosion.ts';
import { routeEps } from '../../../src/core/nodes/simulate/_route.ts';
import { R, combine, count, meanOf } from './_erosion-rig.ts';
import { adjacent, neighbour, outletsOf, referenceRoute } from './_route-reference.ts';

conformance(def, {
  skip: {
    resolution: 'Flow is stream lines one texel wide, which a finer level draws elsewhere (simulation.md 2.8): at shared vertices 257 and 513 differ by 0.82 standard deviations. Out agrees within 0.034 and wear within 0.24, which the last test below asserts.',
  },
});

const SEA = 0.25, PROJECT_SEED = 1;
const alone = { mask: null, upliftMask: null } as const;
/** Erosion and nothing else: no lake is filled afterwards. */
const PURE = { lakeFill: 0 };
/** Without a sea: the border ring is then the only outlet. */
const DRY = { seaLevel: -1 } as const;
const EPS = routeEps(R);

test('simulate/fluvial-erosion: without uplift and lake fill no texel rises, and wear is what was removed', async () => {
  // At 257 the default feature runs on one level; at 513 it starts on 257 and refines once.
  for (const res of [257, 513]) {
    const terrain = fixtures.terrain(res);
    const { out, wear } = await renderNode(def, { res, inputs: { in: terrain, ...alone }, params: PURE, wants: ['out', 'wear'] });
    assert.equal(count(out, (v, i) => v > terrain.data[i]!), 0, `${res}: texels above the input`);
    assert.ok(stats(combine(wear, combine(terrain, out, (a, b) => a - b), (a, b) => Math.abs(a - b))).max <= 1e-7, `${res}: wear is in - out`);
    assert.ok(meanOf(wear) > 0.005, `${res}: the mean wear is ${meanOf(wear)}`);
  }
});

test('simulate/fluvial-erosion: the sea and what lies below it stay as they are', async () => {
  // On one level every texel at or below the sea level is an outlet, and an outlet never changes; across a
  // refinement the node puts them back.
  for (const res of [257, 513]) {
    const terrain = fixtures.terrain(res);
    const { out } = await renderNode(def, { res, inputs: { in: terrain, ...alone }, wants: ['out'] });
    const last = res - 1;
    assert.equal(count(out, (v, i) => terrain.data[i]! <= SEA && v !== terrain.data[i] && i % res > 0 && i % res < last && i >= res && i < last * res), 0, `${res}: texels at or below the sea level that changed`);
    assert.equal(count(out, (v, i) => terrain.data[i]! > SEA && v < SEA), 0, `${res}: land that was cut below the sea level`);
    assert.ok(count(out, (v, i) => v !== terrain.data[i]) > 0.3 * terrain.data.length, `${res}: the land changed`);
  }
});

test('simulate/fluvial-erosion: a mask of 0 everywhere returns the input, and so does a run too short for one iteration', async () => {
  const terrain = fixtures.terrain(257);
  const masked = await renderNode(def, { inputs: { in: terrain, mask: 'zero', upliftMask: null }, params: PURE, wants: ['out'] });
  expectIdentical(masked.out, terrain);
  // At 33 texels the smallest feature and the shortest duration come to less than half an iteration.
  const small = fixtures.terrain(33);
  const short = await renderNode(def, { res: 33, inputs: { in: small, ...alone }, params: { ...PURE, size: 0.01, duration: 0.05 }, wants: ['out'] });
  expectIdentical(short.out, small);
});

test('simulate/fluvial-erosion: with lake fill every texel that is no outlet has a lower neighbour', async () => {
  // The notch fixture has no depression; the terrain fixture has some thirty, which the fill closes.
  for (const name of ['notch', 'terrain'] as const) {
    const input = fixtures[name](257);
    const { out } = await renderNode(def, { inputs: { in: input, ...alone }, settings: DRY, wants: ['out'] });
    let stuck = 0;
    for (let y = 1; y < 256; y++) {
      for (let x = 1; x < 256; x++) {
        const i = y * 257 + x;
        let lowest = Infinity;
        for (let k = 0; k < 4; k++) lowest = Math.min(lowest, out.data[neighbour(i, k, 257)]!);
        if (!(out.data[i]! - lowest >= 0.5 * EPS)) stuck++;
      }
    }
    assert.equal(stuck, 0, `${name}: texels without a neighbour lower by half of ROUTE_EPS`);
  }
});

test('simulate/fluvial-erosion: lake fill closes a depression, and without it the depression stays', async () => {
  // The basin fixture: a slope with one closed depression, whose floor is at 0.147 in the middle of the terrain.
  const basin = fixtures.basin(257);
  const filled = await renderNode(def, { inputs: { in: basin, ...alone }, params: { duration: 0.05 }, settings: DRY, wants: ['out'] });
  const open = await renderNode(def, { inputs: { in: basin, ...alone }, params: { duration: 0.05, lakeFill: 0 }, settings: DRY, wants: ['out'] });
  const half = await renderNode(def, { inputs: { in: basin, ...alone }, params: { duration: 0.05, lakeFill: 0.5 }, settings: DRY, wants: ['out'] });
  const floor = at(basin, 128, 128);
  assert.ok(at(open.out, 128, 128) <= floor, 'without lake fill the floor does not rise');
  const rise = at(filled.out, 128, 128) - floor, part = at(half.out, 128, 128) - at(open.out, 128, 128);
  assert.ok(rise > 0.05, `the fill raised the floor by ${rise}`);
  assert.ok(Math.abs(part - 0.5 * (at(filled.out, 128, 128) - at(open.out, 128, 128))) < 1e-6, `half the fill raised it by ${part}`);
});

test('simulate/fluvial-erosion: flow is the drainage area of the terrain it leaves', async () => {
  // Nothing erodes under a mask of 0, so the terrain it leaves is the input and flow is the router's area of it.
  const terrain = fixtures.terrain(257);
  const { flow } = await renderNode(def, { inputs: { in: terrain, mask: 'zero', upliftMask: null }, params: PURE, wants: ['flow'] });
  const reference = referenceRoute({ height: terrain.data, res: 257, eps: EPS, seaLevel: SEA, routing: 'single', seed: mixSeed(mixSeed(PROJECT_SEED, 0), 0) });
  assert.equal(count(flow, (v, i) => !adjacent(v, reference.area![i]!)), 0, 'texels whose flow is not the reference area');

  // After a run: above 0, no texel without a neighbour that holds at least as much, and all of the terrain at the outlets.
  for (const settings of [{}, DRY]) {
    const eroded = await renderNode(def, { inputs: { in: terrain, ...alone }, params: PURE, settings, wants: ['out', 'flow'] });
    const outlet = outletsOf(terrain.data, 257, 'seaLevel' in settings ? -1 : SEA);
    assert.ok(stats(eroded.flow).min >= Math.fround(1 / (257 * 257)), `the least flow is ${stats(eroded.flow).min}, less than one texel`);
    let sum = 0, heads = 0;
    for (let i = 0; i < eroded.flow.data.length; i++) {
      if (outlet[i]) { sum += eroded.flow.data[i]!; continue; }
      let most = 0;
      for (let k = 0; k < 4; k++) most = Math.max(most, eroded.flow.data[neighbour(i, k, 257)]!);
      if (most < eroded.flow.data[i]!) heads++;
    }
    assert.equal(heads, 0, 'texels that are no outlet and hold more than every neighbour');
    assert.ok(Math.abs(sum - 1) < 1e-4, `the outlets hold ${sum} of the terrain`);
  }
});

test('simulate/fluvial-erosion: where the water gathers the terrain is cut deepest, and the valley floors stay', async () => {
  // The notch fixture: a plane with one channel along row 128, which gathers the water of its banks.
  const { wear, flow } = await renderNode(def, { inputs: { in: 'notch', ...alone }, params: PURE, settings: DRY, wants: ['wear', 'flow'] });
  assert.ok(at(flow, 200, 128) > 20 * at(flow, 200, 40), `the channel drains ${at(flow, 200, 128)}, the plane ${at(flow, 200, 40)}`);
  assert.ok(at(wear, 200, 128) > 3 * at(wear, 200, 40), `wear is ${at(wear, 200, 128)} in the channel and ${at(wear, 200, 40)} on the plane`);

  // On the terrain fixture the slopes are cut and the valley floors, which are the base level of their slopes or
  // lie under a lake, hardly at all: the lowest hundredth of the terrain loses a small part of the mean.
  const terrain = fixtures.terrain(257);
  const run = await renderNode(def, { inputs: { in: terrain, ...alone }, params: PURE, settings: DRY, wants: ['wear'] });
  const low = stats(terrain).p01;
  let floors = 0, n = 0;
  for (let i = 0; i < terrain.data.length; i++) if (terrain.data[i]! <= low) { floors += run.wear.data[i]!; n++; }
  assert.ok(floors / n < 0.2 * meanOf(run.wear), `the lowest ground lost ${floors / n}; the mean wear is ${meanOf(run.wear)}`);
  assert.ok(stats(run.wear).max > 3 * meanOf(run.wear), `the deepest cut is ${stats(run.wear).max}`);
});

test('simulate/fluvial-erosion: a cone is worn alike along the rows and columns and along the diagonals', async () => {
  // The cone fixture is the same in every direction. Receivers taken among the four axial neighbours cut its flanks
  // deeper where they face a row or a column; water shared among all eight lower neighbours does not.
  const cone = fixtures.cone(257);
  for (const seed of [0, 3]) {
    const { wear } = await renderNode(def, { inputs: { in: cone, ...alone }, params: { ...PURE, seed }, settings: DRY, wants: ['wear'] });
    let axial = 0, nAxial = 0, diagonal = 0, nDiagonal = 0;
    for (let y = 0; y < 257; y++) {
      for (let x = 0; x < 257; x++) {
        const dx = x - 128, dy = y - 128, r = Math.hypot(dx, dy);
        if (r < 16 || r > 56) continue;      // the flank, clear of the tip and of the foot
        const turn = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 90;      // 0 and 90 along an axis, 45 along a diagonal
        if (turn < 10 || turn > 80) { axial += wear.data[y * 257 + x]!; nAxial++; } else if (Math.abs(turn - 45) < 10) { diagonal += wear.data[y * 257 + x]!; nDiagonal++; }
      }
    }
    const ratio = (axial / nAxial) / (diagonal / nDiagonal);
    assert.ok(axial / nAxial > 1e-3, `seed ${seed}: the flank wore by ${axial / nAxial}`);
    assert.ok(ratio > 0.9 && ratio < 1.1, `seed ${seed}: the flanks along the axes wore ${ratio} times as much as those along the diagonals`);
  }
});

test('simulate/fluvial-erosion: a longer run and a lower concavity remove more; a talus of 90 degrees leaves the valley sides', async () => {
  const terrain = fixtures.terrain(257);
  const worn = async (params: Record<string, number>): Promise<number> =>
    meanOf((await renderNode(def, { inputs: { in: terrain, ...alone }, params: { ...PURE, ...params }, settings: DRY, wants: ['wear'] })).wear);
  const base = await worn({});
  assert.ok(await worn({ duration: 0.25 }) < 0.6 * base, 'a quarter of the duration wears less');
  assert.ok(await worn({ duration: 2 }) > 1.2 * base, 'twice the duration wears more');
  assert.ok(await worn({ concavity: 0.2 }) > await worn({ concavity: 0.8 }), 'at a low concavity the small streams cut too');
  assert.ok(await worn({ talus: 90 }) < base, 'without the slope limit the valley sides are not worn back');
});

test('simulate/fluvial-erosion: uplift raises the ground where its mask says, and the rivers cut into it', async () => {
  // A level plain: without uplift nothing happens to it; with uplift it rises, less along the border, to which it drains.
  const plain = fixtures.zero(257);
  const flat: FieldData = { ...plain, data: plain.data.map(() => 0.5) };
  const still = await renderNode(def, { inputs: { in: flat, ...alone }, params: PURE, settings: DRY, wants: ['out'] });
  expectIdentical(still.out, flat);
  const risen = await renderNode(def, { inputs: { in: flat, ...alone }, params: { ...PURE, uplift: 0.2 }, settings: DRY, wants: ['out'] });
  assert.ok(at(risen.out, 128, 128) > 0.5 + 0.1 && at(risen.out, 128, 128) <= 0.7 + 1e-6, `the middle of the plain stands at ${at(risen.out, 128, 128)}`);
  assert.ok(at(risen.out, 3, 128) < at(risen.out, 128, 128), 'near the border the rivers keep the ground lower');
  // Where the uplift mask is 0 the ground does not rise.
  const held = await renderNode(def, { inputs: { in: flat, mask: null, upliftMask: 'zero' }, params: { ...PURE, uplift: 0.2 }, settings: DRY, wants: ['out'] });
  expectIdentical(held.out, flat);
});

test('simulate/fluvial-erosion: the valleys of a preview are those of the build', async () => {
  const levels = await renderLadder(def, { params: PURE, settings: DRY });
  expectLadder(levels[257]!.out!, levels[513]!.out!, { rel: 0.08 });
  expectLadder(levels[257]!.wear!, levels[513]!.wear!, { rel: 0.4 });
  const ratio = meanOf(levels[513]!.wear!) / meanOf(levels[257]!.wear!);
  assert.ok(ratio > 0.7 && ratio < 1.4, `mean(wear) at 513 is ${ratio} of that at 257`);
});
